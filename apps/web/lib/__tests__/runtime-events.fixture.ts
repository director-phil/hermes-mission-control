import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildRuntimeTimeline, buildRuntimeAlerts } from "../runtime-events";
import { buildRuntimeSnapshot, type CommandAdapter, type FsAdapter, type RuntimeAdapters, type RuntimeRoots } from "../runtime-truth";

const roots: RuntimeRoots = { procRoot: "/fixture/proc", chatDevRoot: "/fixture/ChatDev", repoRoot: "/fixture/repo" };

test("normalises immutable run JSONL events with source timestamps", async () => {
  const files = {
    "/fixture/ChatDev/goals/state/goal-a.json": JSON.stringify({ id: "goal-a", status: "completed", last_event_timestamp: "2026-08-04T09:30:00.000Z" }),
    "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    "/fixture/ChatDev/runs/goal-a/attempt-1-events.jsonl": [
      JSON.stringify({ type: "review.passed", timestamp: "2026-08-04T09:20:00.000Z", summary: "review ok" }),
      JSON.stringify({ event: "acceptance.passed", timestamp: "2026-08-04T09:25:00.000Z" }),
    ].join("\n"),
  };
  const runtime = await buildRuntimeSnapshot(roots, adapters(files));
  const timeline = await buildRuntimeTimeline(roots, adapters(files), runtime);
  assert.deepEqual(timeline.events.map((event) => event.type), ["review.passed", "acceptance.passed", "goal.completed"]);
  assert.equal(timeline.events[0]?.source.endsWith("attempt-1-events.jsonl"), true);
});

test("alerts cite stale locks, missing controllers, dirty terminal worktrees and orphan processes", async () => {
  const runtime = await buildRuntimeSnapshot(roots, adapters({
    "/fixture/proc/222/status": "Name:\tfastmcp\nPPid:\t1\nVmRSS:\t100 kB\n",
    "/fixture/proc/222/stat": "222 (fastmcp) S 1 0 0 0 0 0 0 0 0 0 1 1 0 0 20 0 1 0 1000 0 0",
    "/fixture/proc/222/cmdline": "fastmcp\0",
    "/fixture/ChatDev/goals/state/goal-b.json": JSON.stringify({ id: "goal-b", status: "running", controller_pid: 999, worktree: "/fixture/repo" }),
    "/fixture/ChatDev/goals/state/goal-b.lock": "999",
    "/fixture/ChatDev/goals/state/goal-c.json": JSON.stringify({ id: "goal-c", status: "failed", worktree: "/fixture/ChatDev/dirty" }),
    "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
  }, true));
  const timeline = await buildRuntimeTimeline(roots, adapters({}, true), runtime);
  const alerts = buildRuntimeAlerts(runtime, timeline);
  assert.equal(timeline.events.some((event) => event.type === "process.orphaned"), true);
  assert.equal(alerts.alerts.some((alert) => alert.title === "Running goal controller missing"), true);
  assert.equal(alerts.alerts.some((alert) => alert.title === "Stale controller lock"), true);
  assert.equal(alerts.alerts.some((alert) => alert.title === "Terminal goal has dirty worktree"), true);
});

test("malformed source rows fail soft as warnings", async () => {
  const runtime = await buildRuntimeSnapshot(roots, adapters({
    "/fixture/ChatDev/goals/state/goal-bad.json": JSON.stringify({ id: "goal-bad", status: "running" }),
    "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    "/fixture/ChatDev/runs/goal-bad/attempt-1-events.jsonl": "{bad json",
  }));
  const timeline = await buildRuntimeTimeline(roots, adapters({
    "/fixture/ChatDev/runs/goal-bad/attempt-1-events.jsonl": "{bad json",
  }), runtime);
  assert.equal(timeline.warnings.some((warning) => warning.message.includes("malformed")), true);
});

test("event payloads redact synthetic secrets and private content fields", async () => {
  const secret = "sk-secretValue123456789";
  const files = {
    "/fixture/ChatDev/goals/state/goal-secret.json": JSON.stringify({ id: "goal-secret", status: "running" }),
    "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    "/fixture/ChatDev/runs/goal-secret/attempt-1-events.jsonl": [
      JSON.stringify({
        type: "tool.completed",
        timestamp: "2026-08-04T09:20:00.000Z",
        summary: `prompt contained ${secret}`,
        message: `private-output ${secret}`,
        title: `env TOKEN=${secret}`,
        tool: `tool body ${secret}`,
        url: `https://example.test/callback?token=${secret}`,
        model: `model-${secret}`,
        stage: `stage-${secret}`,
      }),
    ].join("\n"),
  };
  const runtime = await buildRuntimeSnapshot(roots, adapters(files));
  const timeline = await buildRuntimeTimeline(roots, adapters(files), runtime);
  const serialized = JSON.stringify(timeline);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-output"), false);
  assert.equal(serialized.includes("tool body"), false);
  assert.equal(timeline.events[0]?.summary, "[redacted]");
});

test("event text redacts response output content, secrets, and filesystem paths", async () => {
  const secret = "sk-eventSecret123456789";
  const posixPath = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops/private.txt";
  const windowsPath = "C:\\Users\\phil\\Documents\\data.txt";
  const files = {
    "/fixture/ChatDev/goals/state/goal-sensitive-event.json": JSON.stringify({ id: "goal-sensitive-event", status: "running" }),
    "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
    "/fixture/ChatDev/runs/goal-sensitive-event/attempt-1-events.jsonl": [
      JSON.stringify({
        type: "tool.completed",
        timestamp: "2026-08-04T09:20:00.000Z",
        summary: `model response included ${secret} at ${posixPath}`,
        stage: `opened ${posixPath}`,
        model: `local model at ${windowsPath}`,
        url: `https://example.test/callback?token=${secret}`,
      }),
      JSON.stringify({
        type: "agent.started",
        timestamp: "2026-08-04T09:21:00.000Z",
        summary: `Using worktree ${posixPath} and profile path ${windowsPath}`,
      }),
    ].join("\n"),
  };
  const runtime = await buildRuntimeSnapshot(roots, adapters(files));
  const timeline = await buildRuntimeTimeline(roots, adapters(files), runtime);
  const serialized = JSON.stringify(timeline);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(posixPath), false);
  assert.equal(serialized.includes(windowsPath), false);
  assert.equal(serialized.includes("model response included"), false);
  assert.equal(timeline.events[0]?.summary, "[redacted]");
  assert.equal(timeline.events[1]?.summary.includes("[path]"), true);
});

test("alert payloads redact synthetic secrets from source warnings", async () => {
  const secret = "sk-alertSecret123456789";
  const runtime = await buildRuntimeSnapshot(roots, adapters({
    "/fixture/ChatDev/goals/state/goal-alert.json": JSON.stringify({ id: "goal-alert", status: "running" }),
    "/fixture/ChatDev/goals/state/queue-runner-status.json": "{}",
  }));
  runtime.source_warnings.push({ source: `/private-output/${secret}`, status: "unknown", message: `env TOKEN=${secret}` });
  const timeline = await buildRuntimeTimeline(roots, adapters({}), runtime);
  const alerts = buildRuntimeAlerts(runtime, timeline);
  const serialized = JSON.stringify(alerts);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-output"), false);
  assert.equal(serialized.includes("TOKEN"), false);
});

function adapters(files: Record<string, string>, dirty = false): RuntimeAdapters {
  return {
    fs: memfs(files),
    command: commandAdapter(dirty),
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

function commandAdapter(dirty: boolean): CommandAdapter {
  return {
    async execFile(file, args, options) {
      if (file === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { ok: true, stdout: "feat/test\n", stderr: "", code: 0 };
      if (file === "git" && args[0] === "rev-parse") return { ok: true, stdout: "abc123\n", stderr: "", code: 0 };
      if (file === "git" && args[0] === "status") return { ok: true, stdout: dirty || options?.cwd === "/fixture/ChatDev/dirty" ? " M file.ts\n" : "", stderr: "", code: 0 };
      if (file === "git" && args[0] === "remote") return { ok: true, stdout: "origin\n", stderr: "", code: 0 };
      if (file === "systemctl") return { ok: true, stdout: "", stderr: "", code: 0 };
      return { ok: false, stdout: "", stderr: "", code: 1 };
    },
  };
}
