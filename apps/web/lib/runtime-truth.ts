import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export type EvidenceStatus = "ok" | "unknown" | "warning";
export type GoalStatus = "unknown" | "ready" | "running" | "completed" | "failed" | "paused" | "blocked";
export type ProcessRole = "controller" | "wrapper" | "child" | "model_server" | "systemd_service" | "unrelated";

export interface FsAdapter {
  readFile(filePath: string): Promise<string>;
  readdir(dirPath: string): Promise<string[]>;
  stat(filePath: string): Promise<{ mtimeMs: number; isDirectory(): boolean; isFile(): boolean }>;
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
  live: boolean;
  stale: boolean;
  source: string;
  timestamp: string | null;
}

export interface GoalRecord {
  goal_id: string;
  title: string | null;
  status: GoalStatus;
  controller_pid: number | null;
  controller_lock: ControllerLock | null;
  queue_state: "unknown" | "ready" | "running" | "paused" | "blocked";
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
  source_warnings: Array<{ source: string; status: "unknown" | "warning"; message: string }>;
}

type SourceWarning = RuntimeSnapshot["source_warnings"][number];
const processArgv = new WeakMap<ProcessRecord, string[]>();
const processCgroups = new WeakMap<ProcessRecord, string[]>();

const HOME = os.homedir();
export const DEFAULT_ROOTS: RuntimeRoots = {
  procRoot: "/proc",
  chatDevRoot: path.join(HOME, "ChatDev"),
  repoRoot: "/home/phillip_downs/Documents/GitHub/hermes-mission-control",
};

export const nodeFsAdapter: FsAdapter = {
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  readdir: (dirPath) => fs.readdir(dirPath),
  stat: (filePath) => fs.stat(filePath),
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
  const [processesResult, queue, goalsResult, locksResult, servicesResult, repoWorktree] = await Promise.all([
    readProcesses(roots.procRoot, adapters).catch((error) => {
      source_warnings.push({ source: roots.procRoot, status: "unknown", message: String(error) });
      return { processes: [] as ProcessRecord[], warnings: [] as SourceWarning[] };
    }),
    readQueueStatus(roots, adapters),
    readGoalStates(roots, adapters),
    readControllerLocks(roots, adapters),
    readSystemdServices(adapters),
    readWorktree(roots.repoRoot, adapters),
  ]);
  const processes = processesResult.processes;
  const goalsFromState = goalsResult.goals;
  const locks = locksResult.locks;
  const services = servicesResult.services;
  source_warnings.push(...processesResult.warnings, ...goalsResult.warnings, ...locksResult.warnings, ...servicesResult.warnings);
  if (!repoWorktree) {
    source_warnings.push({ source: path.join(roots.repoRoot, ".git"), status: "unknown", message: "Mission Control Git source missing or unreadable" });
  }

  const goalsById = new Map<string, GoalRecord>();
  for (const goal of goalsFromState) goalsById.set(goal.goal_id, goal);
  for (const lock of locks) {
    const existing = goalsById.get(lock.goal_id);
    if (existing) {
      existing.controller_lock = lock;
      existing.controller_pid = existing.controller_pid ?? lock.pid;
      existing.sources.push({ source: lock.source, timestamp: lock.timestamp, status: lock.stale ? "warning" : "ok" });
    } else {
      goalsById.set(lock.goal_id, unknownGoal(lock.goal_id, { source: lock.source, timestamp: lock.timestamp, status: lock.stale ? "warning" : "ok" }, lock));
    }
  }

  for (const goal of goalsById.values()) {
    goal.queue_state = queue.statusByGoal.get(goal.goal_id) ?? queue.global;
    if (queue.focus_goal_id === goal.goal_id && goal.queue_state === "unknown") goal.queue_state = "running";
    if (!goal.worktree && repoWorktree) goal.worktree = repoWorktree;
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
  for (const raw of argv) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
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
    const worktree = await worktreeFromGoal(data, roots, adapters);
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
      worktree,
      sources: [{ source: filePath, timestamp: stat ? new Date(stat.mtimeMs).toISOString() : null, status: "ok" }],
    }, warning: worktree?.dirty === null && worktree.branch === null && worktree.head === null && worktree.source === worktree.path
      ? { source: worktree.path, status: "warning", message: "observed worktree path rejected by Mission Control allowed roots; Git was not executed" }
      : null };
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
  const locks = await Promise.all(
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
  return { locks: locks.filter((lock): lock is ControllerLock => Boolean(lock)), warnings };
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
    const goals = data.goals;
    if (goals && typeof goals === "object") {
      for (const [goalId, state] of Object.entries(goals as Record<string, unknown>)) {
        statusByGoal.set(goalId, normalizeQueueState(stringValue(state) ?? stringValue((state as Record<string, unknown>)?.status)));
      }
    }
    return {
      global: data.paused === true ? "paused" : normalizeQueueState(stringValue(data.status)),
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

export async function readWorktree(worktreePath: string, adapters: RuntimeAdapters): Promise<WorktreeRecord | null> {
  const [branch, head, dirty, remote, stat] = await Promise.all([
    adapters.command.execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeoutMs: 3_000 }),
    adapters.command.execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 3_000 }),
    adapters.command.execFile("git", ["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 3_000 }),
    adapters.command.execFile("git", ["remote", "get-url", "origin"], { cwd: worktreePath, timeoutMs: 3_000 }),
    adapters.fs.stat(worktreePath).catch(() => null),
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

function classifyProcess(process: ProcessRecord): ProcessRole {
  const argv = redactedArgv(process).join(" ").toLowerCase();
  const name = process.name.toLowerCase();
  if (argv.includes("bridge/escalate.py") && argv.includes(" run ")) return "controller";
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

async function worktreeFromGoal(data: Record<string, unknown>, roots: RuntimeRoots, adapters: RuntimeAdapters): Promise<WorktreeRecord | null> {
  const value = stringValue(data.worktree) ?? stringValue(data.repo) ?? stringValue(data.workspace);
  if (!value) return null;
  if (!isAllowedWorktree(value, roots)) {
    return {
      path: value,
      branch: null,
      head: null,
      dirty: null,
      remote_base: null,
      source: value,
      timestamp: null,
    };
  }
  return readWorktree(value, adapters);
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
  return truncate(argv.slice(0, 3).join(" "), 160);
}

function isAllowedWorktree(worktreePath: string, roots: RuntimeRoots): boolean {
  const resolved = path.resolve(worktreePath);
  const allowed = [roots.repoRoot, roots.chatDevRoot].map((root) => path.resolve(root));
  return allowed.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
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
  if (value === "ready" || value === "pending") return "ready";
  if (value === "paused") return "paused";
  if (value === "blocked") return "blocked";
  return "unknown";
}

function normalizeQueueState(value: string | null): GoalRecord["queue_state"] {
  if (value === "ready" || value === "waiting") return "ready";
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
