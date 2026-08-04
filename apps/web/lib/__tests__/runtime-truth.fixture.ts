import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildRuntimeSnapshot,
  parseProcStat,
  redactArgv,
  type CommandAdapter,
  type FsAdapter,
  type RuntimeAdapters,
  type RuntimeRoots,
} from "../runtime-truth";

const roots: RuntimeRoots = { procRoot: "/fixture/proc", chatDevRoot: "/fixture/ChatDev", repoRoot: "/fixture/repo" };

test("live goal maps controller PID, queue state and git worktree evidence", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/101/status": status("python3", 1, 1200),
      "/fixture/proc/101/stat": stat(101, "python3", 1),
      "/fixture/proc/101/cmdline": cmd("python3", "bridge/escalate.py", "run", "goal-live"),
      "/fixture/ChatDev/goals/state/goal-live.json": JSON.stringify({ id: "goal-live", title: "Live", status: "running", controller_pid: 101, worktree: "/fixture/repo" }),
      "/fixture/ChatDev/goals/state/goal-live.lock": "101",
      "/fixture/ChatDev/goals/state/queue-runner-status.json": JSON.stringify({ focus_goal_id: "goal-live", status: "running" }),
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
      "/fixture/ChatDev/goals/state/goal-stale.json": JSON.stringify({ id: "goal-stale", status: "running", controller_pid: 404 }),
      "/fixture/ChatDev/goals/state/goal-stale.lock": "404",
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const goal = snapshot.goals[0];
  assert.equal(goal?.controller_lock?.stale, true);
  assert.equal(goal?.sources.some((source) => source.status === "warning"), true);
});

test("orphan wrapper is detected when no goal or systemd owner exists", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/222/status": status("fastmcp", 1, 64),
      "/fixture/proc/222/stat": stat(222, "fastmcp", 1),
      "/fixture/proc/222/cmdline": cmd("fastmcp", "--token", "secret-value"),
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    },
  }));
  assert.equal(snapshot.processes[0]?.role, "wrapper");
  assert.equal(snapshot.processes[0]?.orphan, true);
});

test("runtime snapshot never serializes raw argv secrets across API boundary", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/222/status": status("fastmcp", 1, 64),
      "/fixture/proc/222/stat": stat(222, "fastmcp", 1),
      "/fixture/proc/222/cmdline": cmd("fastmcp", "--token", "secret-value"),
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
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
      "/fixture/ChatDev/goals/state/goal-deep.json": JSON.stringify({ id: "goal-deep", status: "running", controller_pid: 101 }),
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    },
  }));
  const grandchild = snapshot.processes.find((process) => process.pid === 103);
  assert.equal(grandchild?.owner_goal_id, "goal-deep");
  assert.equal(grandchild?.orphan, false);
});

test("missing queue source remains unknown instead of healthy", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/ChatDev/goals/state/goal-missing.json": JSON.stringify({ id: "goal-missing", status: "ready" }),
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
      "/fixture/ChatDev/goals/state/goal-outside.json": JSON.stringify({ id: "goal-outside", status: "ready", worktree: "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops" }),
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    },
    gitCwds,
  }));
  assert.equal(gitCwds.includes("/home/phillip_downs/Documents/GitHub/reliable-tradies-ops"), false);
  assert.equal(snapshot.goals[0]?.worktree?.dirty, null);
  assert.equal(snapshot.source_warnings.some((warning) => warning.message.includes("Git was not executed")), true);
});

test("systemd service ownership maps from real user-unit cgroup ancestry without keyword filtering", async () => {
  const snapshot = await buildRuntimeSnapshot(roots, adapters({
    files: {
      "/fixture/proc/500/status": status("custom-worker", 1, 100),
      "/fixture/proc/500/stat": stat(500, "custom-worker", 1),
      "/fixture/proc/500/cmdline": cmd("custom-worker"),
      "/fixture/proc/500/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/custom-worker.service/runtime\n",
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
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
      "/fixture/ChatDev/goals/state/goal-disagree.json": JSON.stringify({ id: "goal-disagree", status: "running", controller_pid: 300 }),
      "/fixture/ChatDev/goals/state/goal-disagree.lock": "301",
      "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    },
  }));
  assert.equal(snapshot.goals[0]?.sources.some((source) => source.note?.includes("disagree")), true);
});

test("redaction removes adjacent secrets, inline tokens and JWT-like values", () => {
  assert.deepEqual(redactArgv(["cmd", "--token", "abc", "api_key=def", "eyJaaaaaaaaaaa.eyJbbbbbbbbbbb"]), ["cmd", "--token", "[REDACTED]", "api_key=[REDACTED]", "[REDACTED]"]);
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

function adapters({
  files,
  gitCwds,
  systemctlOk = true,
  systemctlUnits = [],
  gitOk = true,
}: {
  files: Record<string, string>;
  gitCwds?: string[];
  systemctlOk?: boolean;
  systemctlUnits?: string[];
  gitOk?: boolean;
}): RuntimeAdapters {
  return {
    fs: memfs(files),
    command: commandAdapter({ gitCwds, systemctlOk, systemctlUnits, gitOk }),
    now: () => new Date("2026-08-04T10:00:00.000Z"),
  };
}

function memfs(files: Record<string, string>): FsAdapter {
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
        return {
          ok: true,
          stdout: [
            "LoadState=loaded",
            "ActiveState=active",
            "SubState=running",
            `Description=${unit}`,
            unit === "custom-worker.service" ? "MainPID=0" : "MainPID=0",
            unit === "custom-worker.service" ? "ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/custom-worker.service" : "ControlGroup=",
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
