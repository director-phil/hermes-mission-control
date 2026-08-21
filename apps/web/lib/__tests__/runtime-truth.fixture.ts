import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildRuntimeSnapshot,
  isProvenHermesAgent,
  parseProcStat,
  readWorktree,
  redactArgv,
  type CommandAdapter,
  type FsAdapter,
  type RuntimeAdapters,
  type RuntimeRoots,
} from "../runtime-truth";

const roots: RuntimeRoots = { procRoot: "/fixture/proc", chatDevRoot: "/fixture/LegacyRuntime", repoRoot: "/fixture/repo" };

test("live goal maps controller PID, queue state and git worktree evidence", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/101/status": status("python3", 1, 1200),
      "/fixture/proc/101/stat": stat(101, "python3", 1),
      "/fixture/proc/101/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-live"),
      "/fixture/LegacyRuntime/goals/state/goal-live.json": JSON.stringify({ id: "goal-live", title: "Live", status: "running", controller_pid: 101, worktree: "/fixture/repo" }),
      "/fixture/LegacyRuntime/goals/state/goal-live.lock": "101",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": JSON.stringify({ focus_goal_id: "goal-live", status: "running" }),
    },
  }));
  assert.equal(snapshot.goals[0]?.status, "running");
  assert.equal(snapshot.goals[0]?.controller_lock?.live, true);
  assert.equal(snapshot.goals[0]?.queue_state, "running");
  assert.equal(snapshot.processes[0]?.owner_goal_id, "goal-live");
  assert.equal(snapshot.processes[0]?.role, "controller");
  assert.equal(snapshot.worktrees[0]?.dirty, false);
});

test("stale running goal and stale controller lock stay warning evidence", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/LegacyRuntime/goals/state/goal-stale.json": JSON.stringify({ id: "goal-stale", status: "running", controller_pid: 404 }),
      "/fixture/LegacyRuntime/goals/state/goal-stale.lock": "404",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const goal = snapshot.goals[0];
  assert.equal(goal?.controller_lock?.stale, true);
  assert.equal(goal?.sources.some((source) => source.status === "warning"), true);
});

test("unowned wrapper is observed without false agent-orphan classification", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/222/status": status("fastmcp", 1, 64),
      "/fixture/proc/222/stat": stat(222, "fastmcp", 1),
      "/fixture/proc/222/cmdline": cmd("fastmcp", "--token", "secret-value"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  assert.equal(snapshot.processes[0]?.role, "wrapper");
  assert.equal(snapshot.processes[0]?.orphan, false);
});

test("manual native goal runner process is controller evidence", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/501/status": status("python3", 1, 1200),
      "/fixture/proc/501/stat": stat(501, "python3", 1),
      "/fixture/proc/501/cmdline": cmd("python3", "/home/phillip_downs/Documents/GitHub/hermes-mission-control/scripts/hermes_native_goal_runner.py", "--native-root", "/native-rt"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  assert.equal(snapshot.processes.find((process) => process.pid === 501)?.role, "controller");
  assert.equal(snapshot.processes.filter((process) => process.role === "controller").length, 1);
});

test("systemd native goal runner service is controller evidence with service attribution", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/502/status": status("python3", 1, 1200),
      "/fixture/proc/502/stat": stat(502, "python3", 1),
      "/fixture/proc/502/cmdline": cmd("/usr/bin/env", "python3", "/home/phillip_downs/Documents/GitHub/hermes-mission-control/scripts/hermes_native_goal_runner.py"),
      "/fixture/proc/502/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hermes-native-goal-runner.service\n",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    systemctlUnits: ["hermes-native-goal-runner.service"],
  }));
  const process = snapshot.processes.find((item) => item.pid === 502);
  assert.equal(process?.role, "controller");
  assert.equal(process?.service_unit, "hermes-native-goal-runner.service");
  assert.equal(snapshot.processes.filter((item) => item.pid === 502).length, 1);
  assert.equal(snapshot.processes.filter((item) => item.role === "controller").length, 1);
});

test("runtime snapshot never serializes raw argv secrets across API boundary", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/222/status": status("fastmcp", 1, 64),
      "/fixture/proc/222/stat": stat(222, "fastmcp", 1),
      "/fixture/proc/222/cmdline": cmd("fastmcp", "--token", "secret-value"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const payload = JSON.stringify(snapshot);
  assert.equal(payload.includes("secret-value"), false);
  assert.equal(payload.includes("\"argv\""), false);
  assert.equal(payload.includes("argv_redacted"), true);
  assert.equal(snapshot.processes[0]?.command_identity.includes("[REDACTED]"), true);
});

test("goal ownership propagates through grandchild and deeper PID ancestry", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/101/status": status("python3", 1, 1200),
      "/fixture/proc/101/stat": stat(101, "python3", 1),
      "/fixture/proc/101/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-deep"),
      "/fixture/proc/102/status": status("node", 101, 1200),
      "/fixture/proc/102/stat": stat(102, "node", 101),
      "/fixture/proc/102/cmdline": cmd("node", "worker.js"),
      "/fixture/proc/103/status": status("fastmcp", 102, 64),
      "/fixture/proc/103/stat": stat(103, "fastmcp", 102),
      "/fixture/proc/103/cmdline": cmd("fastmcp"),
      "/fixture/LegacyRuntime/goals/state/goal-deep.json": JSON.stringify({ id: "goal-deep", status: "running", controller_pid: 101 }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const grandchild = snapshot.processes.find((process) => process.pid === 103);
  assert.equal(grandchild?.owner_goal_id, "goal-deep");
  assert.equal(grandchild?.orphan, false);
});

test("missing queue source remains unknown instead of healthy", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/LegacyRuntime/goals/state/goal-missing.json": JSON.stringify({ id: "goal-missing", status: "ready" }),
    },
  }));
  assert.equal(snapshot.goals[0]?.queue_state, "unknown");
  assert.equal(snapshot.source_warnings.some((warning) => warning.source.endsWith("queue-runner-status.json")), true);
});

test("missing and unreadable runtime sources emit explicit unknown warnings", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/999/status": status("node", 1, 1),
    },
    systemctlOk: false,
    gitOk: false,
  }));
  assert.equal(snapshot.source_warnings.some((warning) => warning.source.endsWith("/goals/state") && warning.message.includes("goal-state")), true);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source.endsWith("/goals/state") && warning.message.includes("controller lock")), true);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source === "systemctl --user list-units"), true);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source.endsWith("/proc/999")), true);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source.endsWith("/repo/.git")), true);
});

test("observed worktree paths outside allowed roots are rejected before Git exec", async () => {
  const gitCwds: string[] = [];
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/LegacyRuntime/goals/state/goal-outside.json": JSON.stringify({ id: "goal-outside", status: "ready", worktree: "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops" }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    gitCwds,
  }));
  assert.equal(gitCwds.includes("/home/phillip_downs/Documents/GitHub/reliable-tradies-ops"), false);
  assert.equal(snapshot.goals[0]?.worktree?.dirty, null);
  assert.equal(snapshot.source_warnings.some((warning) => warning.message.includes("Git was not executed")), true);
});

test("forbidden GitHub worktree roots are rejected before any Git exec", async () => {
  const forbidden = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops";
  const gitCwds: string[] = [];
  const snapshot = await buildRuntimeSnapshot({
    ...roots,
    repoRoot: forbidden,
    allowedWorktreeRoots: ["/home/phillip_downs/.hermes/mission-control-worktrees"],
    forbiddenWorktreeRoots: [forbidden],
  }, adapters({
    files: {
      "/fixture/LegacyRuntime/goals/state/goal-forbidden.json": JSON.stringify({ id: "goal-forbidden", status: "ready", worktree: forbidden }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    gitCwds,
  }));
  assert.deepEqual(gitCwds, []);
  assert.equal(snapshot.worktrees.length, 0);
  assert.equal(snapshot.goals[0]?.worktree?.dirty, null);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source === forbidden && warning.message.includes("Git was not executed")), true);
});

test("primary V2 WIP checkout is a default forbidden worktree root", async () => {
  const primaryWip = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops-v2";
  const gitCwds: string[] = [];
  const snapshot = await buildRuntimeSnapshot({
    ...roots,
    allowedWorktreeRoots: ["/home/phillip_downs/.hermes/mission-control-worktrees"],
  }, adapters({
    files: {
      "/fixture/LegacyRuntime/goals/state/goal-primary-wip.json": JSON.stringify({ id: "goal-primary-wip", status: "ready", worktree: primaryWip }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    gitCwds,
  }));
  assert.deepEqual(gitCwds, []);
  assert.equal(snapshot.goals[0]?.worktree?.dirty, null);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source === primaryWip && warning.message.includes("forbidden roots") && warning.message.includes("Git was not executed")), true);
});

test("allowed-root symlink resolving to forbidden worktree is rejected before Git exec", async () => {
  const forbidden = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops";
  const symlink = "/home/phillip_downs/.hermes/mission-control-worktrees/link-to-forbidden";
  const gitCwds: string[] = [];
  const snapshot = await buildRuntimeSnapshot({
    ...roots,
    repoRoot: symlink,
    allowedWorktreeRoots: ["/home/phillip_downs/.hermes/mission-control-worktrees"],
    forbiddenWorktreeRoots: [forbidden],
  }, adapters({
    files: {
      "/fixture/LegacyRuntime/goals/state/goal-symlink.json": JSON.stringify({ id: "goal-symlink", status: "ready", worktree: symlink }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    gitCwds,
    realpaths: {
      [symlink]: forbidden,
    },
  }));
  assert.deepEqual(gitCwds, []);
  assert.equal(snapshot.worktrees.length, 0);
  assert.equal(snapshot.goals[0]?.worktree?.dirty, null);
  assert.equal(snapshot.source_warnings.some((warning) => warning.message.includes("forbidden roots") && warning.message.includes("Git was not executed")), true);
});

test("direct worktree reader rejects controller-forbidden roots before Git exec", async () => {
  const forbidden = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops";
  const gitCwds: string[] = [];
  const worktree = await readWorktree(forbidden, adapters({
    files: {},
    gitCwds,
  }));
  assert.equal(worktree, null);
  assert.deepEqual(gitCwds, []);
});

test("systemd service ownership maps from real user-unit cgroup ancestry without keyword filtering", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/500/status": status("custom-worker", 1, 100),
      "/fixture/proc/500/stat": stat(500, "custom-worker", 1),
      "/fixture/proc/500/cmdline": cmd("custom-worker"),
      "/fixture/proc/500/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/custom-worker.service/runtime\n",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    systemctlUnits: ["custom-worker.service"],
  }));
  const serviceProcess = snapshot.processes.find((process) => process.pid === 500);
  assert.equal(snapshot.services.some((service) => service.unit === "custom-worker.service"), true);
  assert.equal(serviceProcess?.service_unit, "custom-worker.service");
  assert.equal(serviceProcess?.role, "systemd_service");
});

test("source disagreement between goal state and lock is surfaced", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/300/status": status("python3", 1, 1200),
      "/fixture/proc/300/stat": stat(300, "python3", 1),
      "/fixture/proc/300/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-disagree"),
      "/fixture/proc/301/status": status("python3", 1, 1200),
      "/fixture/proc/301/stat": stat(301, "python3", 1),
      "/fixture/proc/301/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-disagree"),
      "/fixture/LegacyRuntime/goals/state/goal-disagree.json": JSON.stringify({ id: "goal-disagree", status: "running", controller_pid: 300 }),
      "/fixture/LegacyRuntime/goals/state/goal-disagree.lock": "301",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  assert.equal(snapshot.goals[0]?.sources.some((source) => source.note?.includes("disagree")), true);
});

test("redaction removes adjacent secrets, inline tokens and JWT-like values", () => {
  assert.deepEqual(redactArgv(["cmd", "--token", "abc", "api_key=def", "eyJaaaaaaaaaaa.eyJbbbbbbbbbbb"]), ["cmd", "--token", "[REDACTED]", "api_key=[REDACTED]", "[REDACTED]"]);
});

test("redaction removes inline shell and interpreter payload content from snapshots and API process records", async () => {
  const payloadMarker = "SYNTHETIC_ACCEPTANCE_PAYLOAD_MARKER";
  const adjacentMarker = "PAYLOAD_ADJACENT_MARKER";
  const nodePayloadMarker = "NODE_EVAL_PAYLOAD_MARKER";
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/101/status": status("python3", 1, 1200),
      "/fixture/proc/101/stat": stat(101, "python3", 1),
      "/fixture/proc/101/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-inline"),
      "/fixture/proc/102/status": status("bash", 101, 64),
      "/fixture/proc/102/stat": stat(102, "bash", 101),
      "/fixture/proc/102/cmdline": cmd("bash", "-lc", `echo ${payloadMarker}`, adjacentMarker),
      "/fixture/proc/103/status": status("node", 102, 64),
      "/fixture/proc/103/stat": stat(103, "node", 102),
      "/fixture/proc/103/cmdline": cmd("node", "--eval", `console.log("${nodePayloadMarker}")`, adjacentMarker),
      "/fixture/LegacyRuntime/goals/state/goal-inline.json": JSON.stringify({ id: "goal-inline", status: "running", controller_pid: 101 }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const apiRecords = snapshot.processes.map((process) => ({
    id: String(process.pid),
    name: process.name,
    role: process.role,
    argv_redacted: process.argv_redacted,
    command_identity: process.command_identity,
  }));
  const serialized = JSON.stringify({ snapshot, apiRecords });
  for (const marker of [payloadMarker, adjacentMarker, nodePayloadMarker]) {
    assert.equal(serialized.includes(marker), false, `${marker} leaked`);
  }
  const shell = snapshot.processes.find((process) => process.pid === 102);
  const node = snapshot.processes.find((process) => process.pid === 103);
  assert.deepEqual(shell?.argv_redacted, ["bash", "-lc", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
  assert.deepEqual(node?.argv_redacted, ["node", "--eval", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
  assert.equal(shell?.command_identity, "bash -lc [REDACTED_INLINE_SCRIPT]");
  assert.equal(node?.command_identity, "node --eval [REDACTED_INLINE_SCRIPT]");
  assert.equal(snapshot.processes.find((process) => process.pid === 101)?.role, "controller");
  assert.equal(shell?.owner_goal_id, "goal-inline");
  assert.equal(node?.owner_goal_id, "goal-inline");
});

test("redaction handles inline-code flags without preserving payload-adjacent args", () => {
  assert.deepEqual(redactArgv(["bash", "-lc", "echo secret payload", "payload-arg"]), ["bash", "-lc", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
  assert.deepEqual(redactArgv(["python3", "-c", "print('secret payload')", "payload-arg"]), ["python3", "-c", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
  assert.deepEqual(redactArgv(["node", "--eval=console.log('secret payload')", "payload-arg"]), ["node", "--eval", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
});

test("redaction handles env wrappers and env assignments before inline code", async () => {
  const shellMarker = "ENV_WRAPPED_INLINE_MARKER";
  const assignmentMarker = "ENV_ASSIGNMENT_INLINE_MARKER";
  const tailMarker = "ENV_WRAPPED_TAIL_MARKER";
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/101/status": status("python3", 1, 1200),
      "/fixture/proc/101/stat": stat(101, "python3", 1),
      "/fixture/proc/101/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-env-inline"),
      "/fixture/proc/102/status": status("env", 101, 64),
      "/fixture/proc/102/stat": stat(102, "env", 101),
      "/fixture/proc/102/cmdline": cmd("/usr/bin/env", "bash", "-lc", `echo ${shellMarker}`, tailMarker),
      "/fixture/proc/103/status": status("env", 101, 64),
      "/fixture/proc/103/stat": stat(103, "env", 101),
      "/fixture/proc/103/cmdline": cmd("/usr/bin/env", "-i", `PAYLOAD=${assignmentMarker}`, "bash", "-lc", `echo ${shellMarker}`, tailMarker),
      "/fixture/LegacyRuntime/goals/state/goal-env-inline.json": JSON.stringify({ id: "goal-env-inline", status: "running", controller_pid: 101 }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const serialized = JSON.stringify(snapshot);
  for (const marker of [shellMarker, assignmentMarker, tailMarker]) {
    assert.equal(serialized.includes(marker), false, `${marker} leaked`);
  }
  assert.deepEqual(snapshot.processes.find((process) => process.pid === 102)?.argv_redacted, ["/usr/bin/env", "bash", "-lc", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
  assert.deepEqual(snapshot.processes.find((process) => process.pid === 103)?.argv_redacted, ["/usr/bin/env", "-i", "PAYLOAD=[REDACTED]", "bash", "-lc", "[REDACTED_INLINE_SCRIPT]", "[REDACTED_INLINE_ARG]"]);
});

test("proc stat parser handles command names with spaces", () => {
  assert.deepEqual(parseProcStat("88 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21"), {
    comm: "node worker",
    ppid: 1,
    utime: 11,
    stime: 12,
    starttime: 19,
  });
});

test("duplicate native goal IDs surface as critical conflicted integrity failure", async () => {
  const snapshot = await buildRuntimeSnapshot({
    ...roots,
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/worktrees"],
  }, adapters({
    files: {
      "/native-rt/goals/ready/duplicate-native.md": nativeGoal("Duplicate Ready", "/fixture/worktrees/a"),
      "/native-rt/goals/running/duplicate-native.md": nativeGoal("Duplicate Running", "/fixture/worktrees/b"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const goal = snapshot.goals.find((item) => item.goal_id === "duplicate-native");
  assert.equal(goal?.status, "conflicted");
  assert.equal(goal?.queue_state, "unknown");
  assert.equal(goal?.sources.length, 2);
  assert.equal(goal?.sources.every((source) => source.status === "warning" && source.note?.startsWith("native-duplicate-state-conflict")), true);
  assert.equal(snapshot.goals.filter((item) => item.goal_id === "duplicate-native").length, 1);
  assert.equal(snapshot.source_warnings.some((warning) => warning.status === "critical" && warning.message.includes("duplicate native goal id duplicate-native")), true);
});

test("unique native goal IDs keep normal status and counts semantics", async () => {
  const snapshot = await buildRuntimeSnapshot({
    ...roots,
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/worktrees"],
  }, adapters({
    files: {
      "/native-rt/goals/ready/unique-native.md": nativeGoal("Unique Ready", "/fixture/worktrees/a"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const goal = snapshot.goals.find((item) => item.goal_id === "unique-native");
  assert.equal(goal?.status, "ready");
  assert.equal(goal?.queue_state, "ready");
  assert.equal(snapshot.source_warnings.some((warning) => warning.message.includes("duplicate native goal id")), false);
});

test("native dependency aliases and list forms surface blockers in runtime truth", async () => {
  const snapshot = await buildRuntimeSnapshot({
    ...roots,
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/worktrees"],
  }, adapters({
    files: {
      "/native-rt/goals/ready/depends-on-scalar.md": nativeGoal("Depends On Scalar", "/fixture/worktrees/a").replace("dependencies:\n", "depends_on: parent-a, parent-b\n"),
      "/native-rt/goals/ready/dependency-ids-list.md": nativeGoal("Dependency Ids List", "/fixture/worktrees/a").replace("dependencies:\n", "dependency_ids:\n  - parent-c\n  - parent-d\n"),
      "/native-rt/goals/ready/dependencies-inline-list.md": nativeGoal("Dependencies Inline List", "/fixture/worktrees/a").replace("dependencies:\n", "dependencies: [parent-e, parent-f]\n"),
      "/native-rt/goals/done/parent-a.md": nativeGoal("Parent A", "/fixture/worktrees/a"),
      "/native-rt/runs/parent-a/result.json": JSON.stringify({ goal_id: "parent-a", success: true }),
      "/native-rt/goals/done/parent-c.md": nativeGoal("Parent C", "/fixture/worktrees/a"),
      "/native-rt/runs/parent-c/result.json": JSON.stringify({ goal_id: "parent-c", success: true }),
      "/native-rt/goals/done/parent-e.md": nativeGoal("Parent E", "/fixture/worktrees/a"),
      "/native-rt/runs/parent-e/result.json": JSON.stringify({ goal_id: "parent-e", success: true }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  assert.deepEqual(snapshot.goals.find((goal) => goal.goal_id === "depends-on-scalar")?.dependency_ids, ["parent-a", "parent-b"]);
  assert.deepEqual(snapshot.goals.find((goal) => goal.goal_id === "depends-on-scalar")?.blocker_ids, ["parent-b"]);
  assert.deepEqual(snapshot.goals.find((goal) => goal.goal_id === "dependency-ids-list")?.dependency_ids, ["parent-c", "parent-d"]);
  assert.deepEqual(snapshot.goals.find((goal) => goal.goal_id === "dependency-ids-list")?.blocker_ids, ["parent-d"]);
  assert.deepEqual(snapshot.goals.find((goal) => goal.goal_id === "dependencies-inline-list")?.dependency_ids, ["parent-e", "parent-f"]);
  assert.deepEqual(snapshot.goals.find((goal) => goal.goal_id === "dependencies-inline-list")?.blocker_ids, ["parent-f"]);
});

function adapters({
  files,
  gitCwds,
  realpaths,
  systemctlOk = true,
  systemctlUnits = [],
  gitOk = true,
}: {
  files: Record<string, string>;
  gitCwds?: string[];
  realpaths?: Record<string, string>;
  systemctlOk?: boolean;
  systemctlUnits?: string[];
  gitOk?: boolean;
}): RuntimeAdapters {
  return {
    fs: memfs(files, realpaths),
    command: commandAdapter({ gitCwds, systemctlOk, systemctlUnits, gitOk }),
    now: () => new Date("2026-08-04T10:00:00.000Z"),
  };
}

function memfs(files: Record<string, string>, realpaths: Record<string, string> = {}): FsAdapter {
  return {
    async readFile(filePath) {
      if (!(filePath in files)) throw new Error(`missing ${filePath}`);
      return files[filePath];
    },
    async readdir(dirPath) {
      const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
      if (!Object.keys(files).some((file) => file.startsWith(prefix))) throw new Error(`missing ${dirPath}`);
      return [...new Set(Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0])
        .filter(Boolean))];
    },
    async stat(filePath) {
      if (!(filePath in files) && !Object.keys(files).some((file) => file.startsWith(`${filePath}/`))) throw new Error(`missing ${filePath}`);
      return { mtimeMs: Date.parse("2026-08-04T09:59:00.000Z"), isDirectory: () => !path.extname(filePath), isFile: () => Boolean(path.extname(filePath)) };
    },
    async realpath(filePath) {
      return realpaths[filePath] ?? filePath;
    },
  };
}

function commandAdapter({
  gitCwds,
  systemctlOk,
  systemctlUnits,
  gitOk,
}: {
  gitCwds?: string[];
  systemctlOk: boolean;
  systemctlUnits: string[];
  gitOk: boolean;
}): CommandAdapter {
  return {
    async execFile(file, args, options) {
      if (file === "git" && options?.cwd) gitCwds?.push(options.cwd);
      if (file === "git" && !gitOk) return { ok: false, stdout: "", stderr: "git source unavailable", code: 1 };
      if (file === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { ok: true, stdout: "feat/truthful-agent-observability\n", stderr: "", code: 0 };
      if (file === "git" && args[0] === "rev-parse") return { ok: true, stdout: "abc123\n", stderr: "", code: 0 };
      if (file === "git" && args[0] === "status") return { ok: true, stdout: "", stderr: "", code: 0 };
      if (file === "git" && args[0] === "remote") return { ok: true, stdout: "https://github.com/director-phil/hermes-mission-control.git\n", stderr: "", code: 0 };
      if (file === "systemctl" && !systemctlOk) return { ok: false, stdout: "", stderr: "systemd unavailable", code: 1 };
      if (file === "systemctl" && args[1] === "list-units") return { ok: true, stdout: systemctlUnits.map((unit) => `${unit} loaded active running fixture`).join("\n"), stderr: "", code: 0 };
      if (file === "systemctl" && args[1] === "show") {
        const unit = args[2];
        const isHermesNative = unit === "hermes-native-goal-runner.service";
        // Return MainPID based on the process PID that's being tested
        // For generic services, use a deterministic mapping: pid 503 -> main_pid 503
        let mainPid = 0;
        if (unit === "generic-service.service") {
          mainPid = 503;
        } else if (isHermesNative) {
          mainPid = 502;
        }
        return {
          ok: true,
          stdout: [
            "LoadState=loaded",
            "ActiveState=active",
            "SubState=running",
            `Description=${unit}`,
            mainPid ? `MainPID=${mainPid}` : "MainPID=0",
            unit === "custom-worker.service"
              ? "ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/custom-worker.service"
              : isHermesNative
                ? "ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/hermes-native-goal-runner.service"
                : unit === "generic-service.service"
                  ? "ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/generic-service.service"
                  : "ControlGroup=",
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      return { ok: false, stdout: "", stderr: "unsupported", code: 1 };
    },
  };
}

function status(name: string, ppid: number, rssKb: number) {
  return `Name:\t${name}\nPPid:\t${ppid}\nVmRSS:\t${rssKb} kB\n`;
}

function stat(pid: number, name: string, ppid: number) {
  return `${pid} (${name}) S ${ppid} 0 0 0 0 0 0 0 0 0 5 6 0 0 20 0 1 0 1000 0 0`;
}

function cmd(...parts: string[]) {
  return `${parts.join("\0")}\0`;
}

function nativeGoal(title: string, worktree: string) {
  return `---
title: ${title}
repo/workdir: ${worktree}
dependencies:
---

${title}

## Allowed files

- \`test.txt\`

## Acceptance

\`\`\`bash
echo test
\`\`\`
`;
}

// isProvenHermesAgent tests
test("isProvenHermesAgent returns false for generic systemd_service", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/503/status": status("generic-service", 1, 100),
      "/fixture/proc/503/stat": stat(503, "generic-service", 1),
      "/fixture/proc/503/cmdline": cmd("generic-service"),
      "/fixture/proc/503/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/generic-service.service/runtime\n",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    systemctlUnits: ["generic-service.service"],
  }));

  const process = snapshot.processes.find((p) => p.pid === 503);
  assert.ok(process, "process should exist");
  // generic systemd_service without hermes-specific unit should have service_unit set but not be a proven agent
  assert.equal(process.role, "systemd_service", "process role should be systemd_service");
  assert.equal(isProvenHermesAgent(process), false, "generic systemd_service should not be a proven Hermes agent");
});

test("isProvenHermesAgent returns true for hermes-native-goal-runner.service", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/504/status": status("python3", 1, 1200),
      "/fixture/proc/504/stat": stat(504, "python3", 1),
      "/fixture/proc/504/cmdline": cmd("/usr/bin/env", "python3", "/home/phillip_downs/Documents/GitHub/hermes-mission-control/scripts/hermes_native_goal_runner.py"),
      "/fixture/proc/504/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hermes-native-goal-runner.service/runtime\n",
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
    systemctlUnits: ["hermes-native-goal-runner.service"],
  }));

  const process = snapshot.processes.find((p) => p.pid === 504);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "controller", "hermes native goal runner should be controller role");
  assert.equal(process.service_unit, "hermes-native-goal-runner.service", "should have correct service unit");
  assert.equal(isProvenHermesAgent(process), true, "hermes-native-goal-runner.service should be a proven Hermes agent");
});

test("isProvenHermesAgent returns true for controller processes", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/505/status": status("python3", 1, 1200),
      "/fixture/proc/505/stat": stat(505, "python3", 1),
      "/fixture/proc/505/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-ctrl"),
      "/fixture/LegacyRuntime/goals/state/goal-ctrl.json": JSON.stringify({ id: "goal-ctrl", status: "running", controller_pid: 505 }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  const process = snapshot.processes.find((p) => p.pid === 505);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "controller", "should be controller role");
  assert.equal(isProvenHermesAgent(process), true, "controller should be a proven Hermes agent");
});

test("isProvenHermesAgent includes goal-owned wrapper processes", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/506/status": status("fastmcp", 1, 64),
      "/fixture/proc/506/stat": stat(506, "fastmcp", 1),
      "/fixture/proc/506/cmdline": cmd("fastmcp"),
      "/fixture/LegacyRuntime/goals/state/goal-wrap.json": JSON.stringify({ id: "goal-wrap", status: "running", controller_pid: 506 }),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  const process = snapshot.processes.find((p) => p.pid === 506);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "wrapper", "should be wrapper role");
  assert.equal(isProvenHermesAgent(process), true, "goal-owned wrapper is a proven Hermes agent");
});

test("isProvenHermesAgent excludes unowned wrapper processes", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/510/status": status("fastmcp", 1, 64),
      "/fixture/proc/510/stat": stat(510, "fastmcp", 1),
      "/fixture/proc/510/cmdline": cmd("fastmcp"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  const process = snapshot.processes.find((p) => p.pid === 510);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "wrapper", "should be wrapper role");
  assert.equal(isProvenHermesAgent(process), false, "unowned wrapper is not a proven Hermes agent");
  assert.equal(process.orphan, false, "unowned wrapper must not create an agent orphan alert");
});

test("isProvenHermesAgent returns false for unrelated processes", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/507/status": status("unknown-app", 1, 64),
      "/fixture/proc/507/stat": stat(507, "unknown-app", 1),
      "/fixture/proc/507/cmdline": cmd("unknown-app"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  const process = snapshot.processes.find((p) => p.pid === 507);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "unrelated", "should be unrelated role");
  assert.equal(isProvenHermesAgent(process), false, "unrelated should not be a proven Hermes agent");
});

test("isProvenHermesAgent excludes unowned model server processes", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/508/status": status("ollama", 1, 64),
      "/fixture/proc/508/stat": stat(508, "ollama", 1),
      "/fixture/proc/508/cmdline": cmd("ollama"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  const process = snapshot.processes.find((p) => p.pid === 508);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "model_server", "should be model_server role");
  assert.equal(isProvenHermesAgent(process), false, "unowned model server is a seat, not a proven agent");
  assert.equal(process.orphan, false, "unowned model seat must not create an agent orphan alert");
});

test("isProvenHermesAgent returns true for child processes", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/509/status": status("node", 100, 64),
      "/fixture/proc/509/stat": stat(509, "node", 100),
      "/fixture/proc/509/cmdline": cmd("node", "worker.js"),
      "/fixture/LegacyRuntime/goals/state/goal-child.json": JSON.stringify({ id: "goal-child", status: "running", controller_pid: 100 }),
      "/fixture/proc/100/status": status("python3", 1, 1200),
      "/fixture/proc/100/stat": stat(100, "python3", 1),
      "/fixture/proc/100/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-child"),
      "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    },
  }));

  const process = snapshot.processes.find((p) => p.pid === 509);
  assert.ok(process, "process should exist");
  assert.equal(process.role, "child", "should be child role");
  assert.equal(isProvenHermesAgent(process), true, "child should be a proven Hermes agent");
});
