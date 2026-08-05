import path from "node:path";
import type {
  FsAdapter,
  GoalRecord,
  RuntimeAdapters,
  RuntimeRoots,
} from "./runtime-truth";
import { isAllowedWorktree, isForbiddenWorktree } from "./runtime-truth";

/**
 * Hermes Native Runtime adapter for Mission Control.
 * Reads native goal state from ~/.hermes/mission-control/runtime/.
 *
 * Note: The primary integration path is through buildRuntimeSnapshot in runtime-truth.ts,
 * which reads native goals natively. This module provides standalone utilities
 * for direct native state access.
 */

export interface NativeGoalRecord extends GoalRecord {
  source_type: "native" | "legacy";
}

export async function readNativeGoalState(
  roots: RuntimeRoots,
  adapters: RuntimeAdapters,
): Promise<{ goals: NativeGoalRecord[]; warnings: { source: string; message: string }[] }> {
  const nativeRoot = roots.nativeRuntimeRoot;
  if (!nativeRoot) return { goals: [], warnings: [] };
  const resolvedRoot = path.resolve(nativeRoot);
  const warnings: { source: string; message: string }[] = [];
  const goals: NativeGoalRecord[] = [];

  const statusDirs = ["ready", "running", "done", "failed"] as const;
  for (const dir of statusDirs) {
    try {
      const entries = await adapters.fs.readdir(path.join(resolvedRoot, "goals", dir));
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const goalId = entry.replace(/\.md$/, "");
        const goalPath = path.join(resolvedRoot, "goals", dir, entry);
        let body: string;
        try {
          body = await adapters.fs.readFile(goalPath);
        } catch {
          warnings.push({ source: goalPath, message: "unreadable goal file" });
          continue;
        }

        const parsed = parseGoalMarkdown(body);
        if (!parsed) {
          warnings.push({ source: goalPath, message: "malformed native goal file" });
          continue;
        }
        const { title, repoWorktree, dependencies, hasAcceptanceBlock } = parsed;
        const worktreePreflight = repoWorktree ? await preflightWorktreeForGit(repoWorktree, roots, adapters) : null;
        const worktreeAllowed = Boolean(worktreePreflight?.ok);
        if (repoWorktree && !worktreeAllowed) {
          warnings.push({
            source: goalPath,
            message: worktreePreflight?.ok === false
              ? `native ${worktreePreflight.message}`
              : "native worktree path rejected by Mission Control allowed roots; Git was not executed",
          });
        }
        const blockerIds = dir === "ready"
          ? await blockedNativeDependencies(resolvedRoot, dependencies, adapters.fs)
          : [];
        const terminalEvidence = dir === "done" || dir === "failed"
          ? await readTerminalEvidence(resolvedRoot, goalId, dir === "done", adapters.fs)
          : null;
        const terminalStatus = terminalEvidence?.status ?? (dir === "ready" ? "ready" : "running");

        goals.push({
          goal_id: goalId,
          title,
          status: terminalStatus,
          controller_pid: null,
          controller_lock: null,
          queue_state: dir === "ready" ? "ready" : dir === "running" ? "running" : "unknown",
          stage: hasAcceptanceBlock ? "acceptance" : null,
          last_event_timestamp: null,
          stall_age_ms: null,
          blocker_ids: blockerIds,
          dependency_ids: dependencies,
          worktree:
            repoWorktree && worktreePreflight?.ok
              ? {
                  path: worktreePreflight.path,
                  branch: null,
                  head: null,
                  dirty: null,
                  remote_base: null,
                  source: path.join(worktreePreflight.path, ".git"),
                  timestamp: null,
                }
              : null,
          sources: [
            { source: goalPath, timestamp: null, status: "ok", note: "native-runner" },
            ...(terminalEvidence
              ? [{
                  source: terminalEvidence.source,
                  timestamp: terminalEvidence.timestamp,
                  status: terminalEvidence.sourceStatus,
                  note: terminalEvidence.note,
                }]
              : []),
            ...(blockerIds.length
              ? [{ source: goalPath, timestamp: null, status: "warning" as const, note: `native-dependency-blocked:${blockerIds.join(",")}` }]
              : []),
          ],
          source_type: "native",
        });
      }
    } catch {
      // Directory may not exist yet — soft fail during migration
    }
  }

  return { goals, warnings };
}

function parseGoalMarkdown(body: string): {
  title: string | null;
  repoWorktree: string | null;
  dependencies: string[];
  hasAcceptanceBlock: boolean;
} | null {
  const lines = body.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let closedFrontmatter = false;
  let fmBody = "";

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closedFrontmatter = true;
      break;
    }
    fmBody += lines[i] + "\n";
  }
  if (!closedFrontmatter) return null;

  const metadata: Record<string, string> = {};
  for (const line of fmBody.split("\n")) {
    if (!line.trim() || !line.includes(":")) continue;
    const [key, ...rest] = line.split(":");
    metadata[key.trim().toLowerCase()] = rest.join(":").trim();
  }

  const hasAcceptanceBlock = body.includes("## Acceptance");

  return {
    title: metadata.title ?? null,
    repoWorktree: metadata["repo/workdir"] ?? metadata.worktree ?? metadata.repo ?? null,
    dependencies: metadata.dependencies
      ? metadata.dependencies.split(",").map((d) => d.trim()).filter(Boolean)
      : [],
    hasAcceptanceBlock,
  };
}

async function blockedNativeDependencies(
  nativeRoot: string,
  dependencies: string[],
  fsAdapter: FsAdapter,
): Promise<string[]> {
  const blockers: string[] = [];
  for (const dependencyId of dependencies) {
    try {
      await fsAdapter.readFile(path.join(nativeRoot, "goals", "done", `${dependencyId}.md`));
      const result = JSON.parse(await fsAdapter.readFile(path.join(nativeRoot, "runs", dependencyId, "result.json"))) as { goal_id?: unknown; success?: unknown };
      if (!terminalResultMatches(result, dependencyId, true)) blockers.push(dependencyId);
    } catch {
      blockers.push(dependencyId);
    }
  }
  return blockers;
}

async function readTerminalEvidence(
  nativeRoot: string,
  goalId: string,
  expectSuccess: boolean,
  fsAdapter: FsAdapter,
): Promise<{ status: GoalRecord["status"]; source: string; timestamp: string | null; sourceStatus: "ok" | "warning"; note: string }> {
  const resultPath = path.join(nativeRoot, "runs", goalId, "result.json");
  try {
    const result = JSON.parse(await fsAdapter.readFile(resultPath)) as { goal_id?: unknown; success?: unknown };
    const timestamp = await sourceTimestamp(fsAdapter, resultPath);
    if (terminalResultMatches(result, goalId, expectSuccess)) {
      return {
        status: expectSuccess ? "completed" : "failed",
        source: resultPath,
        timestamp,
        sourceStatus: "ok",
        note: "native-terminal-result",
      };
    }
    return {
      status: "unknown",
      source: resultPath,
      timestamp,
      sourceStatus: "warning",
      note: "native-terminal-result-mismatched",
    };
  } catch {
    return {
      status: "unknown",
      source: resultPath,
      timestamp: null,
      sourceStatus: "warning",
      note: "native-terminal-result-missing-or-malformed",
    };
  }
}

function terminalResultMatches(result: { goal_id?: unknown; success?: unknown }, goalId: string, success: boolean): boolean {
  return typeof result.goal_id === "string"
    && result.goal_id.length > 0
    && result.goal_id.length <= 128
    && result.goal_id === goalId
    && result.success === success;
}

async function sourceTimestamp(fsAdapter: FsAdapter, source: string): Promise<string | null> {
  try {
    return new Date((await fsAdapter.stat(source)).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

export async function readNativeEvents(
  roots: RuntimeRoots,
  adapters: RuntimeAdapters,
): Promise<{ events: { goal_id: string; type: string; timestamp: string; summary: string }[]; warnings: string[] }> {
  const nativeRoot = roots.nativeRuntimeRoot;
  if (!nativeRoot) return { events: [], warnings: [] };
  const resolvedRoot = path.resolve(nativeRoot);
  const eventsDir = path.join(resolvedRoot, "runs");
  const events: { goal_id: string; type: string; timestamp: string; summary: string }[] = [];
  const warnings: string[] = [];

  try {
    const goalIds = await adapters.fs.readdir(eventsDir);
    for (const goalId of goalIds) {
      const eventFile = path.join(eventsDir, goalId, "events.jsonl");
      try {
        const content = await adapters.fs.readFile(eventFile);
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as { type: string; timestamp: string; summary: string };
            events.push({ goal_id: goalId, type: record.type, timestamp: record.timestamp, summary: sanitizeNativeEventSummary(record.summary) });
          } catch {
            warnings.push(`malformed event in ${eventFile}`);
          }
        }
      } catch {
        // No events file for this goal
      }
    }
  } catch {
    // Events directory doesn't exist yet
  }

  return { events, warnings };
}

type WorktreeGitPreflight =
  | { ok: true; path: string }
  | { ok: false; message: string };

async function preflightWorktreeForGit(
  worktreePath: string,
  roots: RuntimeRoots,
  adapters: RuntimeAdapters,
): Promise<WorktreeGitPreflight> {
  const lexicalPath = path.resolve(worktreePath);
  const lexicalCheck = checkWorktreePath(lexicalPath, roots);
  if (!lexicalCheck.ok) return lexicalCheck;

  let realPath = lexicalPath;
  if (adapters.fs.realpath) {
    try {
      realPath = path.resolve(await adapters.fs.realpath(worktreePath));
    } catch {
      return { ok: false, message: "worktree path could not be resolved; Git was not executed" };
    }
  }

  const realPathCheck = checkWorktreePath(realPath, roots);
  if (!realPathCheck.ok) return realPathCheck;
  return { ok: true, path: realPath };
}

function checkWorktreePath(resolvedPath: string, roots: RuntimeRoots): WorktreeGitPreflight {
  if (isForbiddenWorktree(resolvedPath, roots)) {
    return { ok: false, message: "worktree path rejected by Mission Control forbidden roots; Git was not executed" };
  }
  if (!isAllowedWorktree(resolvedPath, roots)) {
    return { ok: false, message: "worktree path rejected by Mission Control allowed roots; Git was not executed" };
  }
  return { ok: true, path: resolvedPath };
}

function sanitizeNativeEventSummary(value: unknown): string {
  const text = typeof value === "string" && value.length > 0 ? value : "event";
  if (/(prompt|response|tool[_ -]?body|file[_ -]?body|private[_ -]?output|stdout|stderr|env|environment|secret|password|token|api[_ -]?key|credential)/i.test(text)) {
    return "[redacted]";
  }
  return truncate(text
    .replace(/(token|secret|password|api[_-]?key|credential)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(?:\/[\w.-]+){2,}/g, "[path]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\?){2,}/g, "[path]"), 180);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 12)}...[truncated]` : value;
}
