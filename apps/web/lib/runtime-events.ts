import path from "node:path";
import type { FsAdapter, GoalRecord, RuntimeAdapters, RuntimeRoots, RuntimeSnapshot } from "./runtime-truth";
import { DEFAULT_ROOTS, buildRuntimeSnapshot, createNodeRuntimeAdapters } from "./runtime-truth";

export type RuntimeEventType =
  | "goal.created"
  | "goal.ready"
  | "goal.blocked"
  | "goal.claimed"
  | "workspace.created"
  | "agent.started"
  | "model.requested"
  | "tool.started"
  | "tool.completed"
  | "planner.failed"
  | "implementation.failed"
  | "coder.failed"
  | "scope.failed"
  | "worktree.failed"
  | "contract.failed"
  | "runner.failed"
  | "quarantine.failed"
  | "terminal_move.failed"
  | "controller.lock_recovered"
  | "controller.warning"
  | "integrity.recovered"
  | "integrity.quarantined"
  | "integrity.failed"
  | "promotion.skipped"
  | "promotion.blocked"
  | "promotion.failed"
  | "migration.historical_done"
  | "control_plane.failed"
  | "acceptance.started"
  | "acceptance.failed"
  | "acceptance.passed"
  | "review.started"
  | "review.failed"
  | "review.passed"
  | "shipping.started"
  | "shipping.failed"
  | "pr.opened"
  | "ci.started"
  | "ci.failed"
  | "ci.passed"
  | "deploy.started"
  | "deploy.ready"
  | "browser.verified"
  | "process.orphaned"
  | "goal.shipped"
  | "goal.changed_pending_surface_verification"
  | "goal.completed"
  | "goal.failed";

export interface RuntimeEvent {
  id: string;
  goal_id: string;
  type: RuntimeEventType;
  timestamp: string;
  summary: string;
  source: string;
  source_timestamp: string | null;
  severity: "info" | "warning" | "critical";
  metadata: Record<string, string | number | boolean | null>;
}

export interface RuntimeAlert {
  id: string;
  goal_id: string | null;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  evidence: string;
  source_timestamp: string | null;
  action: string;
}

export interface TimelineResponse {
  timestamp: string;
  events: RuntimeEvent[];
  warnings: Array<{ source: string; message: string }>;
}

export interface AlertResponse {
  timestamp: string;
  alerts: RuntimeAlert[];
  summary: { total: number; critical: number; warning: number; info: number };
}

const EVENT_MAP: Record<string, RuntimeEventType> = {
  "goal.created": "goal.created",
  "goal.ready": "goal.ready",
  "goal.blocked": "goal.blocked",
  "goal.claimed": "goal.claimed",
  "workspace.created": "workspace.created",
  "agent.started": "agent.started",
  "model.requested": "model.requested",
  "tool.started": "tool.started",
  "tool.completed": "tool.completed",
  "planner.failed": "planner.failed",
  "implementation.failed": "implementation.failed",
  "coder.failed": "coder.failed",
  "scope.failed": "scope.failed",
  "worktree.failed": "worktree.failed",
  "contract.failed": "contract.failed",
  "runner.failed": "runner.failed",
  "quarantine.failed": "quarantine.failed",
  "terminal_move.failed": "terminal_move.failed",
  "controller.lock_recovered": "controller.lock_recovered",
  "controller.warning": "controller.warning",
  "integrity.recovered": "integrity.recovered",
  "integrity.quarantined": "integrity.quarantined",
  "integrity.failed": "integrity.failed",
  "promotion.skipped": "promotion.skipped",
  "promotion.blocked": "promotion.blocked",
  "promotion.failed": "promotion.failed",
  "migration.historical_done": "migration.historical_done",
  "control_plane.failed": "control_plane.failed",
  "acceptance.started": "acceptance.started",
  "acceptance.failed": "acceptance.failed",
  "acceptance.passed": "acceptance.passed",
  "review.started": "review.started",
  "review.failed": "review.failed",
  "review.passed": "review.passed",
  "shipping.started": "shipping.started",
  "shipping.failed": "shipping.failed",
  "pr.opened": "pr.opened",
  "ci.started": "ci.started",
  "ci.failed": "ci.failed",
  "ci.passed": "ci.passed",
  "deploy.started": "deploy.started",
  "deploy.ready": "deploy.ready",
  "browser.verified": "browser.verified",
  "process.orphaned": "process.orphaned",
  "goal.shipped": "goal.shipped",
  "goal.changed_pending_surface_verification": "goal.changed_pending_surface_verification",
  "goal.completed": "goal.completed",
  "goal.failed": "goal.failed",
  created: "goal.created",
  ready: "goal.ready",
  claimed: "goal.claimed",
  started: "agent.started",
  completed: "goal.completed",
  failed: "goal.failed",
};

export async function buildRuntimeTimeline(
  roots: RuntimeRoots = DEFAULT_ROOTS,
  adapters: RuntimeAdapters = createNodeRuntimeAdapters(),
  snapshot?: RuntimeSnapshot,
): Promise<TimelineResponse> {
  const runtime = snapshot ?? await buildRuntimeSnapshot(roots, adapters);
  const warnings: TimelineResponse["warnings"] = [];
  const events: RuntimeEvent[] = [];

  for (const goal of runtime.goals) {
    const nativeOwned = goal.sources.some((source) => source.note === "native-runner");
    if (roots.nativeRuntimeRoot && nativeOwned) {
      events.push(...await readNativeRunEvents(roots.nativeRuntimeRoot, adapters.fs, goal, warnings));
    } else {
      events.push(...await readGoalRunEvents(roots, adapters.fs, goal, warnings));
    }
    const source = goal.sources[0];
    if (!nativeOwned && goal.status === "completed" && source) {
      events.push(goalStateEvent(goal, "goal.completed", source.source, source.timestamp));
    }
    if (!nativeOwned && goal.status === "failed" && source) {
      events.push(goalStateEvent(goal, "goal.failed", source.source, source.timestamp));
    }
  }

  if (roots.nativeRuntimeRoot) {
    events.push(...await readNativeControllerEvents(roots.nativeRuntimeRoot, adapters.fs, warnings));
  }

  for (const process of runtime.processes.filter((item) => item.orphan)) {
    events.push({
      id: `process.orphaned:${process.pid}`,
      goal_id: process.owner_goal_id ?? "unknown",
      type: "process.orphaned",
      timestamp: process.evidence.timestamp ?? runtime.timestamp,
      summary: `Process ${process.pid} has no active goal or service owner`,
      source: process.evidence.source,
      source_timestamp: process.evidence.timestamp,
      severity: "warning",
      metadata: { pid: process.pid, role: process.role, name: process.name },
    });
  }

  return {
    timestamp: runtime.timestamp,
    events: dedupeEvents(events).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
    warnings,
  };
}

export function buildRuntimeAlerts(snapshot: RuntimeSnapshot, timeline: TimelineResponse): AlertResponse {
  const alerts: RuntimeAlert[] = [];
  const livePids = new Set(snapshot.processes.map((process) => process.pid));

  for (const warning of snapshot.source_warnings) {
    const severity = warning.status === "critical" ? "critical" : "warning";
    alerts.push({
      id: `source:${sanitizeEventText(warning.source)}`,
      goal_id: null,
      severity,
      title: severity === "critical" ? "Runtime integrity failure" : "Runtime source unknown",
      message: sanitizeEventText(warning.message),
      evidence: sanitizeEventText(warning.source),
      source_timestamp: null,
      action: "Inspect the cited source path or service status.",
    });
  }

  for (const goal of snapshot.goals) {
    if (goal.status === "running" && !goal.controller_pid) {
      alerts.push(goalAlert(goal, "critical", "Running goal without controller PID", "Goal state claims running but no controller PID is recorded.", "Check the goal state and queue runner lock."));
    } else if (goal.status === "running" && goal.controller_pid && !livePids.has(goal.controller_pid)) {
      alerts.push(goalAlert(goal, "critical", "Running goal controller missing", `PID ${goal.controller_pid} is not live in /proc.`, "Stop or requeue the cited goal after confirming no live controller exists."));
    }
    if (goal.controller_lock?.invalid) {
      alerts.push(goalAlert(goal, "critical", "Invalid controller lock", "controller.lock is malformed or unreadable; claims are blocked fail-closed.", "Inspect the lock metadata and runner events before removing it."));
    } else if (goal.controller_lock?.stale) {
      alerts.push(goalAlert(goal, "warning", "Stale controller lock", `controller.lock references PID ${goal.controller_lock.pid ?? "unknown"} that is not live.`, "Remove only after verifying the goal is not running."));
    }
    if (goal.controller_lock?.pid && goal.controller_pid && goal.controller_lock.pid !== goal.controller_pid) {
      alerts.push(goalAlert(goal, "critical", "Controller source disagreement", `goal state PID ${goal.controller_pid} disagrees with lock PID ${goal.controller_lock.pid}.`, "Inspect both cited sources before changing queue state."));
    }
    if (goal.status === "conflicted") {
      alerts.push(goalAlert(goal, "critical", "Duplicate native goal ID", "Native state contains the same goal ID in multiple state directories.", "Quarantine duplicate native state before trusting counts or dispatching work."));
    }
    if ((goal.status === "completed" || goal.status === "failed") && goal.worktree?.dirty) {
      alerts.push(goalAlert(goal, "warning", "Terminal goal has dirty worktree", `${goal.worktree.path} has uncommitted Git changes.`, "Inspect git status for the cited worktree."));
    }
    if (goal.stall_age_ms !== null && goal.stall_age_ms > 30 * 60 * 1000 && goal.status === "running") {
      alerts.push(goalAlert(goal, "warning", "Goal stage may be stale", `No sourced event for ${Math.round(goal.stall_age_ms / 60000)} minutes.`, "Inspect latest run JSONL and controller output."));
    }
  }

  for (const process of snapshot.processes) {
    if (process.role !== "unrelated" && !process.owner_goal_id && !process.service_unit) {
      alerts.push({
        id: `process-owner:${process.pid}`,
        goal_id: null,
        severity: process.orphan ? "critical" : "warning",
        title: process.orphan ? "Orphan process" : "Unowned process",
        message: `${process.role} process ${process.pid} has no active goal or systemd owner.`,
        evidence: process.evidence.source,
        source_timestamp: process.evidence.timestamp,
        action: "Match the PID to a goal or service before terminating it.",
      });
    }
  }

  for (const warning of timeline.warnings) {
    alerts.push({
      id: `event-source:${sanitizeEventText(warning.source)}`,
      goal_id: null,
      severity: "warning",
      title: "Malformed event source",
      message: sanitizeEventText(warning.message),
      evidence: sanitizeEventText(warning.source),
      source_timestamp: null,
      action: "Inspect and repair the cited JSONL source if it is still authoritative.",
    });
  }

  return {
    timestamp: snapshot.timestamp,
    alerts: dedupeAlerts(alerts),
    summary: {
      total: alerts.length,
      critical: alerts.filter((alert) => alert.severity === "critical").length,
      warning: alerts.filter((alert) => alert.severity === "warning").length,
      info: alerts.filter((alert) => alert.severity === "info").length,
    },
  };
}

async function readNativeRunEvents(
  nativeRoot: string,
  fsAdapter: FsAdapter,
  goal: GoalRecord,
  warnings: TimelineResponse["warnings"],
): Promise<RuntimeEvent[]> {
  const runDir = path.join(nativeRoot, "runs", goal.goal_id);
  let entries: string[];
  try {
    entries = await fsAdapter.readdir(runDir);
  } catch {
    return []; // No native events directory — normal during migration
  }
  const eventFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const events: RuntimeEvent[] = [];
  for (const file of eventFiles) {
    const source = path.join(runDir, file);
    let body: string;
    let sourceTimestamp: string | null = null;
    try {
      const [content, stat] = await Promise.all([fsAdapter.readFile(source), fsAdapter.stat(source).catch(() => null)]);
      body = content;
      sourceTimestamp = stat ? new Date(stat.mtimeMs).toISOString() : null;
    } catch {
      warnings.push({ source, message: "native run event source unreadable" });
      continue;
    }
    body.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const type = normalizeEventType(raw.type ?? raw.event ?? raw.name);
        if (!type) return;
        const timestamp = stringValue(raw.timestamp) ?? stringValue(raw.ts) ?? sourceTimestamp;
        if (!timestamp) {
          warnings.push({ source, message: `native event line ${index + 1} has no timestamp` });
          return;
        }
        events.push({
          id: `native:${goal.goal_id}:${file}:${index + 1}`,
          goal_id: goal.goal_id,
          type,
          timestamp,
          summary: eventSummary(type, raw),
          source,
          source_timestamp: sourceTimestamp,
          severity: eventSeverity(type),
          metadata: pickMetadata(raw),
        });
      } catch {
        warnings.push({ source, message: `native event line ${index + 1} is malformed JSON` });
      }
    });
  }
  return events;
}

async function readNativeControllerEvents(
  nativeRoot: string,
  fsAdapter: FsAdapter,
  warnings: TimelineResponse["warnings"],
): Promise<RuntimeEvent[]> {
  const source = path.join(nativeRoot, "controller-events.jsonl");
  let body: string;
  let sourceTimestamp: string | null = null;
  try {
    const [content, stat] = await Promise.all([fsAdapter.readFile(source), fsAdapter.stat(source).catch(() => null)]);
    body = content;
    sourceTimestamp = stat ? new Date(stat.mtimeMs).toISOString() : null;
  } catch {
    return [];
  }
  const events: RuntimeEvent[] = [];
  body.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const type = normalizeEventType(raw.type ?? raw.event ?? raw.name);
      if (!type) {
        warnings.push({ source, message: `controller event line ${index + 1} has unmapped type` });
        return;
      }
      const timestamp = stringValue(raw.timestamp) ?? stringValue(raw.ts) ?? sourceTimestamp;
      if (!timestamp) {
        warnings.push({ source, message: `controller event line ${index + 1} has no timestamp` });
        return;
      }
      const metadata = pickMetadata(raw);
      events.push({
        id: `native-controller:${index + 1}`,
        goal_id: typeof metadata.goal_id === "string" ? metadata.goal_id : "controller",
        type,
        timestamp,
        summary: eventSummary(type, raw),
        source,
        source_timestamp: sourceTimestamp,
        severity: eventSeverity(type),
        metadata,
      });
    } catch {
      warnings.push({ source, message: `controller event line ${index + 1} is malformed JSON` });
    }
  });
  return events;
}

async function readGoalRunEvents(
  roots: RuntimeRoots,
  fsAdapter: FsAdapter,
  goal: GoalRecord,
  warnings: TimelineResponse["warnings"],
): Promise<RuntimeEvent[]> {
  const runRoot = path.join(roots.chatDevRoot, "runs", goal.goal_id);
  let entries: string[];
  try {
    entries = await fsAdapter.readdir(runRoot);
  } catch {
    warnings.push({ source: runRoot, message: "run event directory missing or unreadable" });
    return [];
  }
  const eventFiles = entries.filter((entry) => entry.endsWith("-events.jsonl") || entry.endsWith("events.jsonl")).sort();
  const events: RuntimeEvent[] = [];
  for (const file of eventFiles) {
    const source = path.join(runRoot, file);
    let body: string;
    let sourceTimestamp: string | null = null;
    try {
      const [content, stat] = await Promise.all([fsAdapter.readFile(source), fsAdapter.stat(source).catch(() => null)]);
      body = content;
      sourceTimestamp = stat ? new Date(stat.mtimeMs).toISOString() : null;
    } catch {
      warnings.push({ source, message: "run event source unreadable" });
      continue;
    }
    body.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const type = normalizeEventType(raw.type ?? raw.event ?? raw.name);
        if (!type) return;
        const timestamp = stringValue(raw.timestamp) ?? stringValue(raw.ts) ?? sourceTimestamp;
        if (!timestamp) {
          warnings.push({ source, message: `event line ${index + 1} has no timestamp` });
          return;
        }
        events.push({
          id: `${goal.goal_id}:${file}:${index + 1}`,
          goal_id: goal.goal_id,
          type,
          timestamp,
          summary: eventSummary(type, raw),
          source,
          source_timestamp: sourceTimestamp,
          severity: eventSeverity(type),
          metadata: pickMetadata(raw),
        });
      } catch {
        warnings.push({ source, message: `event line ${index + 1} is malformed JSON` });
      }
    });
  }
  return events;
}

function goalStateEvent(goal: GoalRecord, type: "goal.completed" | "goal.failed", source: string, sourceTimestamp: string | null): RuntimeEvent {
  return {
    id: `${type}:${goal.goal_id}`,
    goal_id: goal.goal_id,
    type,
    timestamp: goal.last_event_timestamp ?? sourceTimestamp ?? new Date(0).toISOString(),
    summary: `${goal.goal_id} ${type === "goal.completed" ? "completed" : "failed"}`,
    source,
    source_timestamp: sourceTimestamp,
    severity: type === "goal.failed" ? "warning" : "info",
    metadata: { stage: goal.stage },
  };
}

function goalAlert(goal: GoalRecord, severity: RuntimeAlert["severity"], title: string, message: string, action: string): RuntimeAlert {
  const source = goal.sources.find((item) => item.status === "warning") ?? goal.sources[0];
  return {
    id: `${title}:${goal.goal_id}`,
    goal_id: goal.goal_id,
    severity,
    title: sanitizeEventText(title),
    message: sanitizeEventText(message),
    evidence: sanitizeEventText(source?.source ?? goal.goal_id),
    source_timestamp: source?.timestamp ?? null,
    action: sanitizeEventText(action),
  };
}

function normalizeEventType(value: unknown): RuntimeEventType | null {
  const key = typeof value === "string" ? value : null;
  return key ? EVENT_MAP[key] ?? null : null;
}

function eventSummary(type: RuntimeEventType, raw: Record<string, unknown>): string {
  const summary = stringValue(raw.summary) ?? stringValue(raw.message) ?? stringValue(raw.title);
  return sanitizeEventText(summary ?? type);
}

function eventSeverity(type: RuntimeEventType): RuntimeEvent["severity"] {
  if (type === "integrity.failed" || type === "control_plane.failed") return "critical";
  if (
    type.endsWith(".failed")
    || type === "process.orphaned"
    || type === "controller.warning"
    || type === "integrity.quarantined"
    || type === "promotion.blocked"
  ) {
    return "warning";
  }
  return "info";
}

function pickMetadata(raw: Record<string, unknown>): RuntimeEvent["metadata"] {
  const metadata: RuntimeEvent["metadata"] = {};
  const nested = isRecord(raw.metadata) ? raw.metadata : {};
  for (const source of [raw, nested]) {
    for (const key of METADATA_KEYS) {
      if (Object.keys(metadata).length >= MAX_METADATA_KEYS) return metadata;
      if (!(key in source) || key in metadata) continue;
      const value = sanitizeMetadataValue(key, source[key]);
      if (value !== undefined) metadata[key] = value;
    }
  }
  return metadata;
}

const MAX_METADATA_KEYS = 40;
const MAX_METADATA_STRING_LENGTH = 96;
const MAX_METADATA_LIST_LENGTH = 12;
const METADATA_KEYS = [
  "stage",
  "model",
  "provider",
  "pid",
  "status",
  "exit_code",
  "pr",
  "pr_id",
  "pr_number",
  "pull_request",
  "deployment_id",
  "deployment",
  "url",
  "reason",
  "terminal",
  "state",
  "states",
  "goal_id",
  "branch",
  "base_ref",
  "base_sha",
  "commit_sha",
  "sha256",
  "fingerprint",
  "dependency_id",
  "dependency_ids",
  "dependency_count",
  "blocker_id",
  "blocker_ids",
  "blocker_count",
  "changed_count",
  "terminal_state",
  "success",
  "evidence_sha256",
  "evidence_bytes",
  "worktree_path_hash",
  "dedupe_key",
] as const;

const SAFE_LIST_METADATA_KEYS = new Set<string>(["states", "dependency_ids", "blocker_ids"]);

function sanitizeMetadataValue(key: string, value: unknown): RuntimeEvent["metadata"][string] | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeMetadataString(key, value);
  if (Array.isArray(value) && SAFE_LIST_METADATA_KEYS.has(key)) {
    const items = value
      .filter((item): item is string | number | boolean => ["string", "number", "boolean"].includes(typeof item))
      .slice(0, MAX_METADATA_LIST_LENGTH)
      .map((item) => sanitizeMetadataString(key, String(item)))
      .filter((item) => item !== "[redacted]");
    return items.length > 0 ? items.join(",") : undefined;
  }
  return undefined;
}

function sanitizeMetadataString(key: string, value: string): string {
  if (isUnsafeMetadataKey(key) || isUnsafeMetadataValue(value)) return "[redacted]";
  return truncateText(sanitizeEventText(value), MAX_METADATA_STRING_LENGTH);
}

function isUnsafeMetadataKey(key: string): boolean {
  if (/(_sha256|_sha|_hash)$/.test(key)) return false;
  return /(path|prompt|response|output|stdout|stderr|argv|args|command|cmd|token|secret|password|credential|customer|client|private|email|phone|address)/i.test(key);
}

function isUnsafeMetadataValue(value: string): boolean {
  if (/(prompt|response|tool[_ -]?body|file[_ -]?body|private[_ -]?output|stdout|stderr|env|environment|secret|password|token|api[_ -]?key|credential|customer|client|email|phone|address)/i.test(value)) return true;
  if (/(?:\/[\w.-]+){2,}/.test(value) || /[A-Za-z]:\\(?:[^\\\s]+\\?){2,}/.test(value)) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeEventText(value: string): string {
  const lowered = value.toLowerCase();
  if (/(prompt|response|tool[_ -]?body|file[_ -]?body|private[_ -]?output|output|stdout|stderr|env|environment|secret|password|token|api[_ -]?key|credential)/i.test(lowered)) {
    return "[redacted]";
  }
  return truncateText(value
    .replace(/(token|secret|password|api[_-]?key|credential)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(?:\/[\w.-]+){2,}/g, "[path]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\?){2,}/g, "[path]"), 180);
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 12)}...[truncated]` : value;
}

function dedupeEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function dedupeAlerts(alerts: RuntimeAlert[]): RuntimeAlert[] {
  return [...new Map(alerts.map((alert) => [alert.id, alert])).values()];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
