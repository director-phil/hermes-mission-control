import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseNativeGoalMarkdown } from "./native-goal-markdown";

const execFileAsync = promisify(nodeExecFile);

export type EvidenceStatus = "ok" | "unknown" | "warning";
export type GoalStatus = "unknown" | "staged" | "ready" | "running" | "completed" | "failed" | "changed_pending_surface_verification" | "paused" | "blocked" | "conflicted";
export type ProcessRole = "controller" | "wrapper" | "child" | "model_server" | "systemd_service" | "unrelated";

export interface FsAdapter {
  readFile(filePath: string): Promise<string>;
  readdir(dirPath: string): Promise<string[]>;
  stat(filePath: string): Promise<{ mtimeMs: number; isDirectory(): boolean; isFile(): boolean }>;
  realpath?(filePath: string): Promise<string>;
}

export interface CommandAdapter {
  execFile(
    file: "git" | "systemctl",
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>;
}

export interface RuntimeRoots {
  procRoot: string;
  chatDevRoot: string;
  repoRoot: string;
  nativeRuntimeRoot?: string;
  allowedWorktreeRoots?: string[];
  forbiddenWorktreeRoots?: string[];
}

export interface RuntimeAdapters {
  fs: FsAdapter;
  command: CommandAdapter;
  now(): Date;
}

export interface ProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  argv_redacted: string[];
  command_identity: string;
  role: ProcessRole;
  rss_bytes: number | null;
  cpu_ticks: number | null;
  start_time_ticks: number | null;
  owner_goal_id: string | null;
  service_unit: string | null;
  orphan: boolean;
  evidence: { source: string; timestamp: string | null; status: EvidenceStatus; note?: string };
}

export interface ControllerLock {
  goal_id: string;
  pid: number | null;
  proc_start_ticks: number | null;
  live: boolean;
  stale: boolean;
  invalid?: boolean;
  source: string;
  timestamp: string | null;
}

export interface GoalRecord {
  goal_id: string;
  title: string | null;
  status: GoalStatus;
  controller_pid: number | null;
  controller_lock: ControllerLock | null;
  queue_state: "unknown" | "staged" | "ready" | "running" | "paused" | "blocked";
  stage: string | null;
  last_event_timestamp: string | null;
  stall_age_ms: number | null;
  blocker_ids: string[];
  dependency_ids: string[];
  worktree: WorktreeRecord | null;
  sources: Array<{ source: string; timestamp: string | null; status: EvidenceStatus; note?: string }>;
}

export interface ServiceRecord {
  unit: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  description: string | null;
  main_pid: number | null;
  control_group: string | null;
  source: string;
  timestamp: string | null;
}

export interface WorktreeRecord {
  path: string;
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
  remote_base: string | null;
  source: string;
  timestamp: string | null;
}

export interface RuntimeSnapshot {
  timestamp: string;
  roots: RuntimeRoots;
  goals: GoalRecord[];
  processes: ProcessRecord[];
  services: ServiceRecord[];
  worktrees: WorktreeRecord[];
  source_warnings: Array<{ source: string; status: "unknown" | "warning" | "critical"; message: string }>;
}

type SourceWarning = RuntimeSnapshot["source_warnings"][number];
type NativeTerminalEvidence = {
  status: GoalStatus;
  sourceStatus: EvidenceStatus;
  source: string;
  timestamp: string | null;
  note: string | null;
  warning?: string;
};
const processArgv = new WeakMap<ProcessRecord, string[]>();
const processCgroups = new WeakMap<ProcessRecord, string[]>();

const HOME = os.homedir();
const LEGACY_EXECUTION_DIR = "Chat" + "Dev";
export const DEFAULT_FORBIDDEN_WORKTREE_ROOTS = [
  "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops",
  "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops-v2",
];
export const DEFAULT_ROOTS: RuntimeRoots = {
  procRoot: "/proc",
  chatDevRoot: path.join(HOME, LEGACY_EXECUTION_DIR),
  repoRoot: "/home/phillip_downs/Documents/GitHub/hermes-mission-control",
  nativeRuntimeRoot: path.join(HOME, ".hermes", "mission-control", "runtime"),
  allowedWorktreeRoots: [path.join(HOME, ".hermes", "mission-control-worktrees")],
  forbiddenWorktreeRoots: DEFAULT_FORBIDDEN_WORKTREE_ROOTS,
};

export const nodeFsAdapter: FsAdapter = {
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  readdir: (dirPath) => fs.readdir(dirPath),
  stat: (filePath) => fs.stat(filePath),
  realpath: (filePath) => fs.realpath(filePath),
};

export const nodeCommandAdapter: CommandAdapter = {
  async execFile(file, args, options) {
    try {
      const result = await execFileAsync(file, [...args], {
        cwd: options?.cwd,
        timeout: options?.timeoutMs ?? 4_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number | null; message?: string };
      return {
        ok: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        code: err.code ?? null,
      };
    }
  },
};

export function createNodeRuntimeAdapters(): RuntimeAdapters {
  return { fs: nodeFsAdapter, command: nodeCommandAdapter, now: () => new Date() };
}

export async function buildRuntimeSnapshot(
  roots: RuntimeRoots = DEFAULT_ROOTS,
  adapters: RuntimeAdapters = createNodeRuntimeAdapters(),
): Promise<RuntimeSnapshot> {
  const source_warnings: RuntimeSnapshot["source_warnings"] = [];
  const [processesResult, queue, goalsResult, locksResult, servicesResult, repoWorktreeResult] = await Promise.all([
    readProcesses(roots.procRoot, adapters).catch((error) => {
      source_warnings.push({ source: roots.procRoot, status: "unknown", message: String(error) });
      return { processes: [] as ProcessRecord[], warnings: [] as SourceWarning[] };
    }),
    readQueueStatus(roots, adapters),
    readGoalStates(roots, adapters),
    readControllerLocks(roots, adapters),
    readSystemdServices(adapters),
    readWorktreeSource(roots.repoRoot, roots, adapters),
  ]);
  const repoWorktree = repoWorktreeResult.worktree;
  const processes = processesResult.processes;
  const goalsFromState = goalsResult.goals;
  const locks = locksResult.locks;
  const services = servicesResult.services;
  source_warnings.push(...processesResult.warnings, ...goalsResult.warnings, ...locksResult.warnings, ...servicesResult.warnings);
  if (repoWorktreeResult.warning) {
    source_warnings.push(repoWorktreeResult.warning);
  } else if (!repoWorktree) {
    source_warnings.push({ source: path.join(roots.repoRoot, ".git"), status: "unknown", message: "Mission Control Git source missing or unreadable" });
  }

  const goalsById = new Map<string, GoalRecord>();
  // Label legacy goals explicitly
  for (const goal of goalsFromState) {
    if (!goal.sources.some((s) => s.note === "native-runner")) {
      for (const s of goal.sources) {
        if (!s.note) s.note = "legacy-runtime";
      }
    }
    goalsById.set(goal.goal_id, goal);
  }

  // Read native goals if nativeRuntimeRoot is configured
  if (roots.nativeRuntimeRoot) {
    const nativeResult = await readNativeGoals(roots, adapters, source_warnings);
    for (const nativeGoal of nativeResult) {
      // Native takes precedence over legacy on same goal ID
      goalsById.set(nativeGoal.goal_id, nativeGoal);
    }
  }

  for (const lock of locks) {
    const lockStatus: EvidenceStatus = lock.stale || lock.invalid ? "warning" : "ok";
    const existing = goalsById.get(lock.goal_id);
    if (existing) {
      existing.controller_lock = lock;
      existing.controller_pid = existing.controller_pid ?? lock.pid;
      existing.sources.push({ source: lock.source, timestamp: lock.timestamp, status: lockStatus, note: lock.invalid ? "controller-lock-invalid" : undefined });
    } else {
      goalsById.set(lock.goal_id, unknownGoal(lock.goal_id, { source: lock.source, timestamp: lock.timestamp, status: lockStatus, note: lock.invalid ? "controller-lock-invalid" : undefined }, lock));
    }
  }

  // Read native controller lock if present
  if (roots.nativeRuntimeRoot) {
    const nativeLockResult = await readNativeControllerLock(roots, adapters);
    if (nativeLockResult) {
      const sourceStatus: EvidenceStatus = nativeLockResult.stale || nativeLockResult.invalid ? "warning" : "ok";
      if (nativeLockResult.invalid) {
        source_warnings.push({
          source: nativeLockResult.source,
          status: "warning",
          message: "native controller lock invalid or unreadable; claims blocked fail-closed",
        });
      }
      const existing = goalsById.get(nativeLockResult.goal_id);
      if (existing) {
        existing.controller_lock = nativeLockResult;
        existing.controller_pid = existing.controller_pid ?? nativeLockResult.pid;
        existing.sources.push({
          source: nativeLockResult.source,
          timestamp: nativeLockResult.timestamp,
          status: sourceStatus,
          note: nativeLockResult.invalid ? "controller-lock-invalid" : undefined,
        });
      } else {
        goalsById.set(nativeLockResult.goal_id, unknownGoal(nativeLockResult.goal_id, {
          source: nativeLockResult.source,
          timestamp: nativeLockResult.timestamp,
          status: sourceStatus,
          note: nativeLockResult.invalid ? "controller-lock-invalid" : undefined,
        }, nativeLockResult));
      }
    }
  }

  for (const goal of goalsById.values()) {
    const nativeOwned = goal.sources.some((source) => source.note === "native-runner");
    if (!nativeOwned || goal.queue_state === "unknown") {
      goal.queue_state = queue.statusByGoal.get(goal.goal_id) ?? queue.global;
      if (queue.focus_goal_id === goal.goal_id && goal.queue_state === "unknown") goal.queue_state = "running";
    }
    if (!goal.worktree && repoWorktree && !goal.sources.some((s) => s.note === "native-worktree-rejected")) goal.worktree = repoWorktree;
    goal.stall_age_ms = goal.last_event_timestamp
      ? Math.max(0, adapters.now().getTime() - Date.parse(goal.last_event_timestamp))
      : null;
  }

  const goals = [...goalsById.values()].sort((a, b) => a.goal_id.localeCompare(b.goal_id));
  const ownerByPid = new Map<number, string>();
  for (const goal of goals) {
    if (goal.controller_pid) ownerByPid.set(goal.controller_pid, goal.goal_id);
  }

  const serviceByPid = new Map<number, string>();
  for (const service of services) {
    if (service.main_pid) serviceByPid.set(service.main_pid, service.unit);
  }

  const pidSet = new Set(processes.map((process) => process.pid));
  propagateOwners(processes, ownerByPid);
  propagateServices(processes, services, serviceByPid);
  for (const process of processes) {
    process.owner_goal_id = ownerByPid.get(process.pid) ?? inferGoalFromArgv(redactedArgv(process), goals);
    process.service_unit = serviceByPid.get(process.pid) ?? serviceFromCgroup(process, services);
    process.role = classifyProcess(process);
    process.orphan = process.role !== "unrelated" && !process.owner_goal_id && !process.service_unit;
  }

  for (const goal of goals) {
    if (goal.status === "running" && goal.controller_pid && !pidSet.has(goal.controller_pid)) {
      goal.sources.push({
        source: goal.controller_lock?.source ?? goal.sources[0]?.source ?? "goal-state",
        timestamp: goal.controller_lock?.timestamp ?? null,
        status: "warning",
        note: "goal claims running but controller PID is not live",
      });
    }
    if (goal.controller_lock?.pid && goal.controller_pid && goal.controller_lock.pid !== goal.controller_pid) {
      goal.sources.push({
        source: goal.controller_lock.source,
        timestamp: goal.controller_lock.timestamp,
        status: "warning",
        note: "controller.lock and goal state disagree",
      });
    }
  }

  const worktrees = repoWorktree ? [repoWorktree] : [];
  if (queue.warning) source_warnings.push(queue.warning);

  return {
    timestamp: adapters.now().toISOString(),
    roots,
    goals,
    processes,
    services,
    worktrees,
    source_warnings,
  };
}

// ---------------------------------------------------------------------------
// Native runtime readers
// ---------------------------------------------------------------------------

async function readNativeGoals(roots: RuntimeRoots, adapters: RuntimeAdapters, warnings: SourceWarning[]): Promise<GoalRecord[]> {
  const nativeRoot = roots.nativeRuntimeRoot;
  if (!nativeRoot) return [];
  const goals: Array<GoalRecord & { native_state_dir: string }> = [];
  const statusDirs = ["staged", "ready", "running", "done", "failed", "changed_pending_surface_verification"] as const;
  const queueMap: Record<string, GoalRecord["queue_state"]> = { staged: "staged", ready: "ready", running: "running", done: "unknown", failed: "unknown", changed_pending_surface_verification: "unknown" };
  for (const dir of statusDirs) {
    let entries: string[];
    try {
      entries = await adapters.fs.readdir(path.join(nativeRoot, "goals", dir));
    } catch {
      continue; // directory may not exist yet — soft fail during migration
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const goalId = entry.replace(/\.md$/, "");
      const goalPath = path.join(nativeRoot, "goals", dir, entry);
      let body: string;
      try {
        body = await adapters.fs.readFile(goalPath);
      } catch {
        warnings.push({ source: goalPath, status: "warning", message: "unreadable native goal file" });
        continue;
      }
      const parsed = parseNativeGoalMarkdown(body);
      if (!parsed) {
        warnings.push({ source: goalPath, status: "warning", message: "malformed native goal file" });
        continue;
      }
      const worktreeValue = parsed.repoWorktree;
      const worktreePreflight = worktreeValue ? await preflightWorktreeForGit(worktreeValue, roots, adapters) : null;
      const worktreeAllowed = Boolean(worktreePreflight?.ok);
      const worktreeRejected = Boolean(worktreeValue) && !worktreeAllowed;
      if (worktreeRejected) {
        warnings.push({
          source: goalPath,
          status: worktreePreflight?.ok === false ? worktreePreflight.status : "warning",
          message: worktreePreflight?.ok === false
            ? `native ${worktreePreflight.message}`
            : "native worktree path rejected by Mission Control allowed roots; Git was not executed",
        });
      }
      const blockerIds = dir === "ready" || dir === "staged"
        ? await blockedNativeDependencies(nativeRoot, parsed.dependencies, adapters.fs)
        : [];
      const terminal: NativeTerminalEvidence = dir === "done" || dir === "failed" || dir === "changed_pending_surface_verification"
        ? await readNativeTerminalResult(nativeRoot, goalId, adapters.fs, dir)
        : { status: dir === "staged" ? "staged" : dir === "ready" ? "ready" : "running", sourceStatus: "ok", source: goalPath, timestamp: null, note: null };
      if (terminal.warning) warnings.push({ source: terminal.source, status: "warning", message: terminal.warning });
      goals.push({
        goal_id: goalId,
        title: parsed.title,
        status: terminal.status,
        controller_pid: null,
        controller_lock: null,
        queue_state: queueMap[dir] ?? "unknown",
        stage: parsed.hasAcceptance ? "acceptance" : null,
        last_event_timestamp: null,
        stall_age_ms: null,
        blocker_ids: blockerIds,
        dependency_ids: parsed.dependencies,
        worktree: worktreeValue && worktreeAllowed ? await readWorktree(worktreeValue, adapters, roots) : null,
        native_state_dir: dir,
        sources: [
          { source: goalPath, timestamp: null, status: "ok", note: "native-runner" },
          ...(terminal.note
            ? [{ source: terminal.source, timestamp: terminal.timestamp, status: terminal.sourceStatus, note: terminal.note }]
            : []),
          ...(blockerIds.length
            ? [{ source: goalPath, timestamp: null, status: "warning" as const, note: `native-dependency-blocked:${blockerIds.join(",")}` }]
            : []),
          ...(worktreeRejected ? [{ source: goalPath, timestamp: null, status: "warning" as const, note: "native-worktree-rejected" }] : []),
        ],
      });
    }
  }
  return collapseNativeGoalConflicts(goals, nativeRoot, warnings);
}

function collapseNativeGoalConflicts(
  goals: Array<GoalRecord & { native_state_dir: string }>,
  nativeRoot: string,
  warnings: SourceWarning[],
): GoalRecord[] {
  const byId = new Map<string, Array<GoalRecord & { native_state_dir: string }>>();
  for (const goal of goals) {
    byId.set(goal.goal_id, [...(byId.get(goal.goal_id) ?? []), goal]);
  }
  const collapsed: GoalRecord[] = [];
  for (const [goalId, records] of byId) {
    if (records.length === 1) {
      const { native_state_dir: _stateDir, ...goal } = records[0];
      collapsed.push(goal);
      continue;
    }
    const conflictSources = records
      .flatMap((record) => record.sources.filter((source) => source.note === "native-runner").map((source) => ({
        state: record.native_state_dir,
        source: source.source,
      })))
      .sort((a, b) => a.state.localeCompare(b.state) || a.source.localeCompare(b.source));
    const states = [...new Set(conflictSources.map((item) => item.state))].sort();
    const paths = conflictSources.map((item) => path.relative(nativeRoot, item.source));
    warnings.push({
      source: path.join(nativeRoot, "goals"),
      status: "critical",
      message: `duplicate native goal id ${goalId} across states ${states.join(",")} at ${paths.join(",")}`,
    });
    collapsed.push({
      goal_id: goalId,
      title: null,
      status: "conflicted",
      controller_pid: null,
      controller_lock: null,
      queue_state: "unknown",
      stage: null,
      last_event_timestamp: null,
      stall_age_ms: null,
      blocker_ids: [],
      dependency_ids: [...new Set(records.flatMap((record) => record.dependency_ids))].sort(),
      worktree: null,
      sources: conflictSources.map((item) => ({
        source: item.source,
        timestamp: null,
        status: "warning" as const,
        note: `native-duplicate-state-conflict:${item.state}`,
      })),
    });
  }
  return collapsed;
}

async function readNativeTerminalResult(
  nativeRoot: string,
  goalId: string,
  fsAdapter: FsAdapter,
  dir: "done" | "failed" | "changed_pending_surface_verification",
): Promise<NativeTerminalEvidence> {
  const resultPath = path.join(nativeRoot, "runs", goalId, "result.json");
  try {
    const result = JSON.parse(await fsAdapter.readFile(resultPath)) as { goal_id?: unknown; success?: unknown; provenance?: unknown; terminal_state?: unknown };
    const resultTimestamp = await sourceTimestamp(fsAdapter, resultPath);
    const expectSuccess = dir === "done";
    const pendingMatch = dir === "changed_pending_surface_verification"
      && terminalResultMatches(result, goalId, false)
      && result.terminal_state === "changed_pending_surface_verification";
    if (terminalResultMatches(result, goalId, expectSuccess) && (dir !== "changed_pending_surface_verification" || pendingMatch)) {
      const migrated = result.provenance === "migrated_historical";
      return {
        status: dir === "done" ? "completed" : dir === "failed" ? "failed" : "changed_pending_surface_verification",
        sourceStatus: "ok",
        source: resultPath,
        timestamp: resultTimestamp,
        note: migrated ? "native-terminal-result:migrated_historical" : "native-terminal-result",
      };
    }
    return {
      status: "unknown",
      sourceStatus: "warning",
      source: resultPath,
      timestamp: resultTimestamp,
      note: "native-terminal-result-mismatched",
      warning: `native terminal result mismatch for ${goalId}`,
    };
  } catch {
    return {
      status: "unknown",
      sourceStatus: "warning",
      source: resultPath,
      timestamp: null,
      note: "native-terminal-result-missing-or-malformed",
      warning: `native terminal result missing or malformed for ${goalId}`,
    };
  }
}

async function sourceTimestamp(fsAdapter: FsAdapter, source: string): Promise<string | null> {
  try {
    return new Date((await fsAdapter.stat(source)).mtimeMs).toISOString();
  } catch {
    return null;
  }
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

function terminalResultMatches(result: { goal_id?: unknown; success?: unknown }, goalId: string, success: boolean): boolean {
  return typeof result.goal_id === "string"
    && result.goal_id.length > 0
    && result.goal_id.length <= 128
    && result.goal_id === goalId
    && result.success === success;
}

async function readNativeControllerLock(roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<ControllerLock | null> {
  const nativeRoot = roots.nativeRuntimeRoot;
  if (!nativeRoot) return null;
  const lockPath = path.join(nativeRoot, "controller.lock");
  const stat = await adapters.fs.stat(lockPath).catch(() => null);
  try {
    const body = await adapters.fs.readFile(lockPath);
    const data = JSON.parse(body) as Record<string, unknown>;
    const pid = numberValue(data.pid);
    const procStartTicks = numberValue(data.proc_start_ticks);
    const goalId = stringValue(data.goal_id);
    if (!goalId || !pid || !procStartTicks) {
      return {
        goal_id: goalId ?? "unknown-lock",
        pid,
        proc_start_ticks: procStartTicks,
        live: false,
        stale: false,
        invalid: true,
        source: lockPath,
        timestamp: stat ? new Date(stat.mtimeMs).toISOString() : null,
      };
    }
    const actualStartTicks = pid ? await readProcStartTicks(roots.procRoot, pid, adapters) : null;
    const live = Boolean(pid && procStartTicks && actualStartTicks === procStartTicks);
    return {
      goal_id: goalId,
      pid,
      proc_start_ticks: procStartTicks,
      live,
      stale: Boolean(pid && procStartTicks && !live),
      source: lockPath,
      timestamp: stat ? new Date(stat.mtimeMs).toISOString() : null,
    };
  } catch {
    if (!stat) return null;
    return {
      goal_id: "unknown-lock",
      pid: null,
      proc_start_ticks: null,
      live: false,
      stale: false,
      invalid: true,
      source: lockPath,
      timestamp: new Date(stat.mtimeMs).toISOString(),
    };
  }
}

export async function readProcesses(procRoot: string, adapters: RuntimeAdapters): Promise<{ processes: ProcessRecord[]; warnings: SourceWarning[] }> {
  let entries: string[];
  try {
    entries = await adapters.fs.readdir(procRoot);
  } catch {
    return { processes: [], warnings: [{ source: procRoot, status: "unknown", message: "proc source missing or unreadable" }] };
  }
  const pids = entries.map((entry) => Number(entry)).filter((pid) => Number.isInteger(pid) && pid > 0);
  const records = await Promise.all(pids.map((pid) => readProcess(procRoot, pid, adapters)));
  const warnings: SourceWarning[] = records.flatMap((record, index) => record ? [] : [{
    source: path.join(procRoot, String(pids[index])),
    status: "unknown",
    message: "proc entry missing or unreadable",
  }]);
  return {
    processes: records.filter((record): record is ProcessRecord => Boolean(record)),
    warnings,
  };
}

export async function readProcess(procRoot: string, pid: number, adapters: RuntimeAdapters): Promise<ProcessRecord | null> {
  const source = path.join(procRoot, String(pid));
  try {
    const [status, stat, cmdline, cgroup, statInfo] = await Promise.all([
      adapters.fs.readFile(path.join(source, "status")),
      adapters.fs.readFile(path.join(source, "stat")),
      adapters.fs.readFile(path.join(source, "cmdline")).catch(() => ""),
      adapters.fs.readFile(path.join(source, "cgroup")).catch(() => ""),
      adapters.fs.stat(source).catch(() => null),
    ]);
    const statusMap = parseStatus(status);
    const statInfoParsed = parseProcStat(stat);
    const argv = parseCmdline(cmdline, statusMap.Name ?? statInfoParsed.comm ?? "unknown");
    const argv_redacted = redactArgv(argv);
    const record: ProcessRecord = {
      pid,
      ppid: Number(statusMap.PPid ?? statInfoParsed.ppid ?? 0),
      name: statusMap.Name ?? statInfoParsed.comm ?? "unknown",
      argv_redacted,
      command_identity: commandIdentity(argv_redacted),
      role: "unrelated",
      rss_bytes: statusMap.VmRSS ? Number(statusMap.VmRSS.split(/\s+/)[0]) * 1024 : null,
      cpu_ticks: statInfoParsed.utime !== null && statInfoParsed.stime !== null ? statInfoParsed.utime + statInfoParsed.stime : null,
      start_time_ticks: statInfoParsed.starttime,
      owner_goal_id: null,
      service_unit: null,
      orphan: false,
      evidence: {
        source: path.join(source, "status"),
        timestamp: statInfo ? new Date(statInfo.mtimeMs).toISOString() : null,
        status: "ok",
      },
    };
    processArgv.set(record, argv);
    processCgroups.set(record, parseCgroupPaths(cgroup));
    return record;
  } catch {
    return null;
  }
}

export function parseProcStat(stat: string): { comm: string | null; ppid: number | null; utime: number | null; stime: number | null; starttime: number | null } {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return { comm: null, ppid: null, utime: null, stime: null, starttime: null };
  const comm = stat.slice(open + 1, close);
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return {
    comm,
    ppid: numberOrNull(fields[1]),
    utime: numberOrNull(fields[11]),
    stime: numberOrNull(fields[12]),
    starttime: numberOrNull(fields[19]),
  };
}

export function redactArgv(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  let redactInlineTail = false;
  const interpreterIndex = inlineInterpreterIndex(argv);
  const executable = interpreterIndex >= 0 ? argv[interpreterIndex] : (argv[0] ?? "");
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (redactInlineTail) {
      redacted.push("[REDACTED_INLINE_ARG]");
      continue;
    }
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    if (interpreterIndex > 0 && index < interpreterIndex && isEnvAssignment(raw)) {
      redacted.push(redactAssignmentValue(raw));
      continue;
    }
    const inlineFlag = index > interpreterIndex ? inlineCodeFlag(raw, executable) : null;
    if (inlineFlag) {
      const [flagName, inlineValue] = inlineFlag;
      redacted.push(flagName);
      if (inlineValue !== null) {
        redacted.push("[REDACTED_INLINE_SCRIPT]");
        redactInlineTail = true;
      } else if (index + 1 < argv.length) {
        redacted.push("[REDACTED_INLINE_SCRIPT]");
        index += 1;
        redactInlineTail = true;
      }
      continue;
    }
    const arg = raw.replace(/(token|secret|password|api[_-]?key|credential)=([^&\s]+)/gi, "$1=[REDACTED]");
    if (/^(--?(token|secret|password|api-key|apikey|credential)|-p)$/i.test(raw)) {
      redacted.push(raw);
      redactNext = true;
    } else if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(arg)) {
      redacted.push("[REDACTED]");
    } else {
      redacted.push(arg);
    }
  }
  return redacted;
}

function inlineInterpreterIndex(argv: readonly string[]): number {
  const firstBase = path.basename(argv[0] ?? "").toLowerCase();
  if (firstBase !== "env") return argv.length > 0 ? 0 : -1;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (isEnvAssignment(arg)) continue;
    if (arg === "-i" || arg === "--ignore-environment" || arg === "-0" || arg === "--null") continue;
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--unset=") || arg.startsWith("--chdir=") || arg.startsWith("-u") && arg.length > 2) continue;
    return index;
  }
  return 0;
}

function isEnvAssignment(arg: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg);
}

function redactAssignmentValue(arg: string): string {
  const equals = arg.indexOf("=");
  return equals > 0 ? `${arg.slice(0, equals)}=[REDACTED]` : arg;
}

function inlineCodeFlag(raw: string, executable: string): [string, string | null] | null {
  const equals = raw.indexOf("=");
  const flagName = equals > 0 ? raw.slice(0, equals) : raw;
  const inlineValue = equals > 0 ? raw.slice(equals + 1) : null;
  const base = path.basename(executable).toLowerCase();
  const shellNames = new Set(["bash", "dash", "sh", "zsh", "fish", "ksh"]);
  const nodeNames = new Set(["node", "nodejs", "bun", "deno"]);
  const interpreterNames = new Set(["python", "python3", "python2", "perl", "ruby", "php"]);

  if (shellNames.has(base)) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(flagName) || flagName === "--command") return [flagName, inlineValue];
  }
  if (nodeNames.has(base)) {
    if (flagName === "-e" || flagName === "--eval" || flagName === "-p" || flagName === "--print") return [flagName, inlineValue];
  }
  if (interpreterNames.has(base)) {
    if (flagName === "-c" || flagName === "-e" || flagName === "-r") return [flagName, inlineValue];
  }
  if (!base || flagName === "-c" || flagName === "-e" || flagName === "--eval") return [flagName, inlineValue];
  return null;
}

async function readGoalStates(roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<{ goals: GoalRecord[]; warnings: SourceWarning[] }> {
  const stateRoot = path.join(roots.chatDevRoot, "goals", "state");
  let entries: string[];
  try {
    entries = await adapters.fs.readdir(stateRoot);
  } catch {
    return { goals: [], warnings: [{ source: stateRoot, status: "unknown", message: "goal-state directory missing or unreadable" }] };
  }
  const files = entries.filter((entry) => entry.endsWith(".json"));
  const results = await Promise.all(files.map((file) => readGoalState(path.join(stateRoot, file), roots, adapters)));
  return {
    goals: results.map((result) => result.goal).filter((goal): goal is GoalRecord => Boolean(goal)),
    warnings: results.map((result) => result.warning).filter((warning): warning is SourceWarning => Boolean(warning)),
  };
}

async function readGoalState(filePath: string, roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<{ goal: GoalRecord | null; warning: SourceWarning | null }> {
  try {
    const [body, stat] = await Promise.all([adapters.fs.readFile(filePath), adapters.fs.stat(filePath).catch(() => null)]);
    const data = JSON.parse(body) as Record<string, unknown>;
    const goalId = stringValue(data.id) ?? path.basename(filePath, ".json");
    const worktreeResult = await worktreeFromGoal(data, roots, adapters);
    return { goal: {
      goal_id: goalId,
      title: stringValue(data.title),
      status: normalizeGoalStatus(stringValue(data.status) ?? stringValue(data.state) ?? stringValue(data.stage)),
      controller_pid: numberValue(data.controller_pid) ?? numberValue(data.controllerPid),
      controller_lock: null,
      queue_state: "unknown",
      stage: stringValue(data.stage),
      last_event_timestamp: stringValue(data.last_event_timestamp) ?? stringValue(data.updated_at) ?? stringValue(data.updatedAt),
      stall_age_ms: null,
      blocker_ids: stringArray(data.blockers ?? data.blocker_ids),
      dependency_ids: stringArray(data.dependencies ?? data.dependency_ids ?? data.depends_on),
      worktree: worktreeResult.worktree,
      sources: [{ source: filePath, timestamp: stat ? new Date(stat.mtimeMs).toISOString() : null, status: "ok" }],
    }, warning: worktreeResult.warning };
  } catch {
    return { goal: null, warning: { source: filePath, status: "unknown", message: "goal-state file missing, unreadable, or malformed" } };
  }
}

async function readControllerLocks(roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<{ locks: ControllerLock[]; warnings: SourceWarning[] }> {
  const stateRoot = path.join(roots.chatDevRoot, "goals", "state");
  let entries: string[];
  try {
    entries = await adapters.fs.readdir(stateRoot);
  } catch {
    return { locks: [], warnings: [{ source: stateRoot, status: "unknown", message: "controller lock directory missing or unreadable" }] };
  }
  const warnings: SourceWarning[] = [];
  const locks: Array<ControllerLock | null> = await Promise.all(
    entries.filter((entry) => entry.endsWith(".lock") || entry === "controller.lock").map(async (entry) => {
      const source = path.join(stateRoot, entry);
      const goalFromName = entry === "controller.lock" ? null : entry.replace(/\.lock$/, "");
      try {
        const [body, stat] = await Promise.all([adapters.fs.readFile(source), adapters.fs.stat(source).catch(() => null)]);
        const parsed = parseLock(body, goalFromName);
        const live = parsed.pid ? await processExists(roots.procRoot, parsed.pid, adapters) : false;
        return {
          goal_id: parsed.goal_id,
          pid: parsed.pid,
          proc_start_ticks: null,
          live,
          stale: Boolean(parsed.pid && !live),
          source,
          timestamp: stat ? new Date(stat.mtimeMs).toISOString() : null,
        };
      } catch {
        warnings.push({ source, status: "unknown", message: "controller lock missing or unreadable" });
        return null;
      }
    }),
  );
  return { locks: locks.filter((lock): lock is ControllerLock => lock !== null), warnings };
}

function parseLock(body: string, fallbackGoalId: string | null): { goal_id: string; pid: number | null } {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "number" || typeof parsed === "string") {
      return { goal_id: fallbackGoalId ?? "unknown", pid: numberOrNull(parsed) };
    }
    const data = parsed as Record<string, unknown>;
    return {
      goal_id: stringValue(data.goal_id) ?? stringValue(data.goalId) ?? fallbackGoalId ?? "unknown",
      pid: numberValue(data.pid) ?? numberValue(data.controller_pid),
    };
  } catch {
    const lines = body.trim().split(/\s+/);
    return { goal_id: fallbackGoalId ?? "unknown", pid: numberOrNull(lines[0]) };
  }
}

async function readQueueStatus(roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<{
  global: GoalRecord["queue_state"];
  focus_goal_id: string | null;
  statusByGoal: Map<string, GoalRecord["queue_state"]>;
  warning: RuntimeSnapshot["source_warnings"][number] | null;
}> {
  const source = path.join(roots.chatDevRoot, "goals", "state", "queue-runner-status.json");
  try {
    const body = await adapters.fs.readFile(source);
    const data = JSON.parse(body) as Record<string, unknown>;
    const statusByGoal = new Map<string, GoalRecord["queue_state"]>();

    // Legacy shape support: { goals: { <id>: <state> } }
    const goals = data.goals;
    if (goals && typeof goals === "object") {
      for (const [goalId, state] of Object.entries(goals as Record<string, unknown>)) {
        statusByGoal.set(goalId, normalizeQueueState(stringValue(state) ?? stringValue((state as Record<string, unknown>)?.status)));
      }
    }

    // Current queue-runner shape support: active[], controller_pids[], up_next[], blocked[], counts{}
    const active = Array.isArray(data.active) ? data.active : [];
    for (const value of active) {
      const goalId = stringValue(value);
      if (goalId) statusByGoal.set(goalId, "running");
    }

    const controllerPids = Array.isArray(data.controller_pids) ? data.controller_pids : [];
    const upNext = Array.isArray(data.up_next) ? data.up_next : [];

    const counts = (data.counts && typeof data.counts === "object")
      ? (data.counts as Record<string, unknown>)
      : null;
    const blockedCount = counts ? numberValue(counts.blocked) ?? 0 : 0;
    const heldCount = counts ? numberValue(counts.held) ?? 0 : 0;
    const hardStopCount = counts ? numberValue(counts.hard_stop) ?? 0 : 0;
    const invalidCount = counts ? numberValue(counts.invalid) ?? 0 : 0;
    const blockingTotal = numberValue(data.blocking_total) ?? (blockedCount + heldCount + hardStopCount + invalidCount);

    const explicitStatus = normalizeQueueState(stringValue(data.status));
    const global: GoalRecord["queue_state"] = data.paused === true
      ? "paused"
      : active.length > 0 || controllerPids.length > 0
        ? "running"
        : explicitStatus !== "unknown"
          ? explicitStatus
          : blockingTotal > 0
            ? "blocked"
            : upNext.length > 0
              ? "ready"
              : "unknown";

    return {
      global,
      focus_goal_id: stringValue(data.focus_goal_id) ?? stringValue(data.focus),
      statusByGoal,
      warning: null,
    };
  } catch {
    return {
      global: "unknown",
      focus_goal_id: null,
      statusByGoal: new Map(),
      warning: { source, status: "unknown", message: "queue-runner-status.json missing or unreadable" },
    };
  }
}

async function readSystemdServices(adapters: RuntimeAdapters): Promise<{ services: ServiceRecord[]; warnings: SourceWarning[] }> {
  const list = await adapters.command.execFile("systemctl", ["--user", "list-units", "--type=service", "--all", "--plain", "--no-legend"], { timeoutMs: 4_000 });
  if (!list.ok) return { services: [], warnings: [{ source: "systemctl --user list-units", status: "unknown", message: "systemd user unit inventory missing or unreadable" }] };
  const units = list.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((unit) => unit?.endsWith(".service"));
  const limitedUnits = units.slice(0, 200);
  const services = await Promise.all(limitedUnits.map((unit) => readSystemdUnit(unit, adapters)));
  const warnings: SourceWarning[] = services.flatMap((service, index) => service ? [] : [{
    source: `systemctl --user show ${limitedUnits[index]}`,
    status: "unknown",
    message: "systemd user unit unreadable",
  }]);
  return { services: services.filter((service): service is ServiceRecord => Boolean(service)), warnings };
}

async function readSystemdUnit(unit: string, adapters: RuntimeAdapters): Promise<ServiceRecord | null> {
  const result = await adapters.command.execFile("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState,SubState,Description,MainPID,ControlGroup"], { timeoutMs: 4_000 });
  if (!result.ok) return null;
  const props = Object.fromEntries(result.stdout.split("\n").map((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ["", ""];
  }).filter(([key]) => key));
  return {
    unit,
    load_state: props.LoadState ?? "unknown",
    active_state: props.ActiveState ?? "unknown",
    sub_state: props.SubState ?? "unknown",
    description: props.Description || null,
    main_pid: numberOrNull(props.MainPID),
    control_group: props.ControlGroup || null,
    source: `systemctl --user show ${unit}`,
    timestamp: adapters.now().toISOString(),
  };
}

export async function readWorktree(worktreePath: string, adapters: RuntimeAdapters, roots?: RuntimeRoots): Promise<WorktreeRecord | null> {
  const preflight = await preflightWorktreeForGit(worktreePath, roots, adapters);
  if (!preflight.ok) return null;
  const gitCwd = preflight.path;
  const [branch, head, dirty, remote, stat] = await Promise.all([
    adapters.command.execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitCwd, timeoutMs: 3_000 }),
    adapters.command.execFile("git", ["rev-parse", "HEAD"], { cwd: gitCwd, timeoutMs: 3_000 }),
    adapters.command.execFile("git", ["status", "--porcelain=v1"], { cwd: gitCwd, timeoutMs: 3_000 }),
    adapters.command.execFile("git", ["remote", "get-url", "origin"], { cwd: gitCwd, timeoutMs: 3_000 }),
    adapters.fs.stat(gitCwd).catch(() => null),
  ]);
  if (!branch.ok && !head.ok) return null;
  return {
    path: worktreePath,
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    dirty: dirty.ok ? dirty.stdout.trim().length > 0 : null,
    remote_base: remote.ok ? remote.stdout.trim() : null,
    source: path.join(worktreePath, ".git"),
    timestamp: stat ? new Date(stat.mtimeMs).toISOString() : null,
  };
}

async function readWorktreeSource(worktreePath: string, roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<{ worktree: WorktreeRecord | null; warning: SourceWarning | null }> {
  const preflight = await preflightWorktreeForGit(worktreePath, roots, adapters);
  if (!preflight.ok) {
    return {
      worktree: null,
      warning: { source: worktreePath, status: preflight.status, message: preflight.message },
    };
  }
  return { worktree: await readWorktree(worktreePath, adapters, roots), warning: null };
}

function classifyProcess(process: ProcessRecord): ProcessRole {
  const argv = redactedArgv(process).join(" ").toLowerCase();
  const name = process.name.toLowerCase();
  if (argv.includes("bridge/escalate.py") && argv.includes(" run ")) return "controller";
  if (argv.includes("hermes_native_goal_runner.py") || process.service_unit === "hermes-native-goal-runner.service") return "controller";
  if (argv.includes("fastmcp") || argv.includes("mcp-server")) return process.owner_goal_id ? "wrapper" : "wrapper";
  if (name.includes("ollama") || name.includes("vllm") || argv.includes("llama-server")) return "model_server";
  if (process.owner_goal_id && process.ppid > 1) return "child";
  if (process.service_unit) return "systemd_service";
  return "unrelated";
}

function inferGoalFromArgv(argv: readonly string[], goals: readonly GoalRecord[]): string | null {
  const joined = argv.join(" ");
  for (const goal of goals) {
    if (joined.includes(goal.goal_id)) return goal.goal_id;
  }
  return null;
}

async function worktreeFromGoal(
  data: Record<string, unknown>,
  roots: RuntimeRoots,
  adapters: RuntimeAdapters,
): Promise<{ worktree: WorktreeRecord | null; warning: SourceWarning | null }> {
  const value = stringValue(data.worktree) ?? stringValue(data.repo) ?? stringValue(data.workspace);
  if (!value) return { worktree: null, warning: null };
  const preflight = await preflightWorktreeForGit(value, roots, adapters);
  if (!preflight.ok) {
    return {
      worktree: {
        path: value,
        branch: null,
        head: null,
        dirty: null,
        remote_base: null,
        source: value,
        timestamp: null,
      },
      warning: { source: value, status: preflight.status, message: preflight.message },
    };
  }
  return { worktree: await readWorktree(value, adapters, roots), warning: null };
}

function propagateOwners(processes: ProcessRecord[], ownerByPid: Map<number, string>) {
  propagatePidMap(processes, ownerByPid);
}

function propagateServices(processes: ProcessRecord[], services: ServiceRecord[], serviceByPid: Map<number, string>) {
  propagatePidMap(processes, serviceByPid);
  for (const process of processes) {
    const unit = serviceFromCgroup(process, services);
    if (unit) serviceByPid.set(process.pid, unit);
  }
}

function propagatePidMap(processes: ProcessRecord[], valueByPid: Map<number, string>) {
  const childrenByPpid = new Map<number, ProcessRecord[]>();
  for (const process of processes) {
    const children = childrenByPpid.get(process.ppid) ?? [];
    children.push(process);
    childrenByPpid.set(process.ppid, children);
  }
  const queue = [...valueByPid.keys()];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    const value = valueByPid.get(pid);
    if (!value) continue;
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (!valueByPid.has(child.pid)) valueByPid.set(child.pid, value);
      queue.push(child.pid);
    }
  }
}

function serviceFromCgroup(process: ProcessRecord, services: readonly ServiceRecord[]): string | null {
  const cgroups = processCgroups.get(process) ?? [];
  for (const service of services) {
    if (!service.control_group) continue;
    if (cgroups.some((cgroup) => cgroup === service.control_group || cgroup.startsWith(`${service.control_group}/`))) return service.unit;
  }
  return null;
}

function parseCgroupPaths(cgroup: string): string[] {
  return cgroup.split("\n").map((line) => line.split(":").at(-1)?.trim()).filter((value): value is string => Boolean(value));
}

function redactedArgv(process: ProcessRecord): string[] {
  return process.argv_redacted.length > 0 ? process.argv_redacted : redactArgv(processArgv.get(process) ?? [process.name]);
}

function commandIdentity(argv: readonly string[]): string {
  return truncate(safeCommandIdentity(argv).join(" "), 160);
}

function safeCommandIdentity(argv: readonly string[]): string[] {
  const identity = argv.slice(0, 4);
  const inlineIndex = identity.findIndex((arg) => arg === "[REDACTED_INLINE_SCRIPT]");
  if (inlineIndex >= 0) return identity.slice(0, inlineIndex + 1);
  return identity;
}

export function isAllowedWorktree(worktreePath: string, roots: RuntimeRoots): boolean {
  const resolved = path.resolve(worktreePath);
  // Use injected allowedWorktreeRoots if present, otherwise fall back to repo and legacy roots.
  const allowed = roots.allowedWorktreeRoots
    ? roots.allowedWorktreeRoots.map((root) => path.resolve(root))
    : [roots.repoRoot, roots.chatDevRoot].map((root) => path.resolve(root));
  // Never allow nativeRuntimeRoot or the legacy execution root as code worktrees.
  if (isForbiddenWorktree(resolved, roots)) return false;
  return allowed.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function isForbiddenWorktree(worktreePath: string, roots?: RuntimeRoots): boolean {
  const resolved = path.resolve(worktreePath);
  const forbidden = [
    roots?.nativeRuntimeRoot ? path.resolve(roots.nativeRuntimeRoot) : null,
    ...DEFAULT_FORBIDDEN_WORKTREE_ROOTS.map((root) => path.resolve(root)),
    ...(roots?.forbiddenWorktreeRoots ?? []).map((root) => path.resolve(root)),
  ].filter((v): v is string => Boolean(v));
  return forbidden.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

type WorktreeGitPreflight =
  | { ok: true; path: string }
  | { ok: false; status: "unknown" | "warning"; message: string };

async function preflightWorktreeForGit(
  worktreePath: string,
  roots: RuntimeRoots | undefined,
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
      return { ok: false, status: "unknown", message: "worktree path could not be resolved; Git was not executed" };
    }
  }

  const realPathCheck = checkWorktreePath(realPath, roots);
  if (!realPathCheck.ok) return realPathCheck;
  return { ok: true, path: realPath };
}

function checkWorktreePath(resolvedPath: string, roots: RuntimeRoots | undefined): WorktreeGitPreflight {
  if (isForbiddenWorktree(resolvedPath, roots)) {
    return { ok: false, status: "warning", message: "worktree path rejected by Mission Control forbidden roots; Git was not executed" };
  }
  if (roots && !isAllowedWorktree(resolvedPath, roots)) {
    return { ok: false, status: "warning", message: "worktree path rejected by Mission Control allowed roots; Git was not executed" };
  }
  return { ok: true, path: resolvedPath };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 12)}...[truncated]` : value;
}

function unknownGoal(goalId: string, source: GoalRecord["sources"][number], lock: ControllerLock | null): GoalRecord {
  return {
    goal_id: goalId,
    title: null,
    status: "unknown",
    controller_pid: lock?.pid ?? null,
    controller_lock: lock,
    queue_state: "unknown",
    stage: null,
    last_event_timestamp: null,
    stall_age_ms: null,
    blocker_ids: [],
    dependency_ids: [],
    worktree: null,
    sources: [source],
  };
}

function parseStatus(status: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of status.split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) parsed[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return parsed;
}

function parseCmdline(cmdline: string, fallback: string): string[] {
  const parts = cmdline.split("\0").filter(Boolean);
  return parts.length > 0 ? parts : [fallback];
}

function normalizeGoalStatus(value: string | null): GoalStatus {
  if (value === "done" || value === "complete" || value === "completed") return "completed";
  if (value === "fail" || value === "failed" || value === "error") return "failed";
  if (value === "running" || value === "claimed" || value === "in_progress") return "running";
  if (value === "staged") return "staged";
  if (value === "changed_pending_surface_verification") return "changed_pending_surface_verification";
  if (value === "ready" || value === "pending") return "ready";
  if (value === "paused") return "paused";
  if (value === "blocked") return "blocked";
  if (value === "conflicted") return "conflicted";
  return "unknown";
}

function normalizeQueueState(value: string | null): GoalRecord["queue_state"] {
  if (value === "ready" || value === "waiting") return "ready";
  if (value === "staged") return "staged";
  if (value === "running" || value === "claimed" || value === "focused") return "running";
  if (value === "paused") return "paused";
  if (value === "blocked") return "blocked";
  return "unknown";
}

async function processExists(procRoot: string, pid: number, adapters: RuntimeAdapters): Promise<boolean> {
  try {
    await adapters.fs.stat(path.join(procRoot, String(pid)));
    return true;
  } catch {
    return false;
  }
}

async function readProcStartTicks(procRoot: string, pid: number, adapters: RuntimeAdapters): Promise<number | null> {
  try {
    const stat = await adapters.fs.readFile(path.join(procRoot, String(pid), "stat"));
    return parseProcStat(stat).starttime;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? numberOrNull(value) : null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
