import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  readNativeGoalState,
  readNativeEvents,
} from "../hermes-native-runtime";
import {
  buildRuntimeSnapshot,
  type RuntimeRoots,
  type RuntimeAdapters,
  type FsAdapter,
  type CommandAdapter,
} from "../runtime-truth";
import { buildRuntimeTimeline as buildTimeline } from "../runtime-events";

// --- Standalone native adapter tests ---

test("reads native goal state from ready, running, done, failed directories", async () => {
  const files: Record<string, string> = {
    "/runtime/goals/ready/test-goal.md": `---
title: Test Goal
repo/workdir: /fixture/repo
dependencies:
---

Test goal for canary validation.

## Acceptance

\`\`\`bash
echo "self-test passed"
exit 0
\`\`\`
`,
    "/runtime/goals/running/another-goal.md": `---
title: Running Goal
repo/workdir: /fixture/repo
dependencies: test-goal
---

Another goal.
`,
    "/runtime/goals/done/completed-goal.md": `---
title: Completed Goal
repo/workdir: /fixture/repo
dependencies:
---

Completed goal.
`,
    "/runtime/goals/failed/failed-goal.md": `---
title: Failed Goal
repo/workdir: /fixture/repo
dependencies:
---

Failed goal.
`,
    "/runtime/goals/done/mismatched-goal.md": `---
title: Mismatched Goal
repo/workdir: /fixture/repo
dependencies:
---

Mismatched goal.
`,
    "/runtime/runs/completed-goal/result.json": JSON.stringify({ goal_id: "completed-goal", success: true }),
    "/runtime/runs/failed-goal/result.json": JSON.stringify({ goal_id: "failed-goal", success: false }),
    "/runtime/runs/mismatched-goal/result.json": JSON.stringify({ goal_id: "other-goal", success: true }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/runtime",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const adapters = {
    fs: memfs(files),
    command: stubCommand(),
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  };

  const result = await readNativeGoalState(roots, adapters);

  assert.equal(result.goals.length, 5);
  const readyGoal = result.goals.find((g) => g.goal_id === "test-goal");
  assert.ok(readyGoal);
  assert.equal(readyGoal?.status, "ready");

  const runningGoal = result.goals.find((g) => g.goal_id === "another-goal");
  assert.ok(runningGoal);
  assert.equal(runningGoal?.status, "running");

  const doneGoal = result.goals.find((g) => g.goal_id === "completed-goal");
  assert.ok(doneGoal);
  assert.equal(doneGoal?.status, "completed");
  assert.deepEqual(doneGoal?.sources.find((s) => s.note === "native-terminal-result"), {
    source: "/runtime/runs/completed-goal/result.json",
    timestamp: "2026-08-05T09:59:00.000Z",
    status: "ok",
    note: "native-terminal-result",
  });

  const failedGoal = result.goals.find((g) => g.goal_id === "failed-goal");
  assert.ok(failedGoal);
  assert.equal(failedGoal?.status, "failed");
  assert.deepEqual(failedGoal?.sources.find((s) => s.note === "native-terminal-result"), {
    source: "/runtime/runs/failed-goal/result.json",
    timestamp: "2026-08-05T09:59:00.000Z",
    status: "ok",
    note: "native-terminal-result",
  });

  assert.deepEqual(runningGoal?.dependency_ids, ["test-goal"]);

  const mismatchedGoal = result.goals.find((g) => g.goal_id === "mismatched-goal");
  assert.ok(mismatchedGoal);
  assert.equal(mismatchedGoal?.status, "unknown");
  assert.equal(mismatchedGoal?.sources.some((s) => s.note === "native-terminal-result-mismatched"), true);
});

test("reads native events from JSONL files", async () => {
  const files: Record<string, string> = {
    "/runtime/runs/goal-1/events.jsonl": [
      JSON.stringify({ type: "goal.claimed", timestamp: "2026-08-05T09:00:00.000Z", summary: "Goal claimed" }),
      JSON.stringify({ type: "agent.started", timestamp: "2026-08-05T09:01:00.000Z", summary: "Agent started" }),
      JSON.stringify({ type: "goal.completed", timestamp: "2026-08-05T09:30:00.000Z", summary: "Goal completed" }),
    ].join("\n"),
  };

  const roots: RuntimeRoots = {
    procRoot: "/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/runtime",
  };

  const adapters = {
    fs: memfs(files),
    command: stubCommand(),
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  };

  const result = await readNativeEvents(roots, adapters);

  assert.equal(result.events.length, 3);
  assert.equal(result.events[0]?.goal_id, "goal-1");
  assert.equal(result.events[0]?.type, "goal.claimed");
  assert.equal(result.events[2]?.summary, "Goal completed");
});

test("reads staged, pending surface, and migrated historical native evidence", async () => {
  const files: Record<string, string> = {
    "/runtime/goals/staged/staged-goal.md": `---
title: Staged Goal
repo/workdir: /fixture/repo
dependencies: migrated-parent
---

Staged goal.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
    "/runtime/goals/done/migrated-parent.md": nativeGoal("Migrated Parent"),
    "/runtime/runs/migrated-parent/result.json": JSON.stringify({ goal_id: "migrated-parent", success: true, provenance: "migrated_historical" }),
    "/runtime/goals/changed_pending_surface_verification/surface-pending.md": nativeGoal("Surface Pending"),
    "/runtime/runs/surface-pending/result.json": JSON.stringify({ goal_id: "surface-pending", success: false, terminal_state: "changed_pending_surface_verification" }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/runtime",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const result = await readNativeGoalState(roots, fullAdapters(files));
  const staged = result.goals.find((goal) => goal.goal_id === "staged-goal");
  const migrated = result.goals.find((goal) => goal.goal_id === "migrated-parent");
  const pending = result.goals.find((goal) => goal.goal_id === "surface-pending");

  assert.equal(staged?.status, "staged");
  assert.equal(staged?.queue_state, "staged");
  assert.deepEqual(staged?.blocker_ids, []);
  assert.equal(migrated?.status, "completed");
  assert.equal(migrated?.sources.some((source) => source.note === "native-terminal-result:migrated_historical"), true);
  assert.equal(pending?.status, "changed_pending_surface_verification");
  assert.equal(pending?.sources.some((source) => source.note === "native-terminal-result"), true);
});

test("standalone native events redact prompts responses secrets and paths", async () => {
  const secret = "sk-nativeSecret123456789";
  const sensitivePath = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops/private.txt";
  const files: Record<string, string> = {
    "/runtime/runs/goal-1/events.jsonl": [
      JSON.stringify({ type: "goal.claimed", timestamp: "2026-08-05T09:00:00.000Z", summary: "Goal claimed" }),
      JSON.stringify({ type: "agent.message", timestamp: "2026-08-05T09:01:00.000Z", summary: `prompt response contained ${secret} at ${sensitivePath}` }),
      JSON.stringify({ type: "goal.completed", timestamp: "2026-08-05T09:30:00.000Z", summary: "Goal completed" }),
    ].join("\n"),
  };

  const roots: RuntimeRoots = {
    procRoot: "/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/runtime",
  };

  const result = await readNativeEvents(roots, fullAdapters(files));
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("prompt response contained"), false);
  assert.equal(serialized.includes(sensitivePath), false);
  assert.equal(result.events[0]?.summary, "Goal claimed");
  assert.equal(result.events[1]?.summary, "[redacted]");
  assert.equal(result.events[2]?.summary, "Goal completed");
});

test("handles missing native runtime root gracefully", async () => {
  const roots: RuntimeRoots = {
    procRoot: "/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/nonexistent/runtime",
  };

  const adapters = {
    fs: {
      async readFile() { throw new Error("not found"); },
      async readdir() { throw new Error("not found"); },
      async stat() { throw new Error("not found"); },
    },
    command: stubCommand(),
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  };

  const result = await readNativeGoalState(roots, adapters);
  assert.equal(result.goals.length, 0);
});

// --- buildRuntimeSnapshot native integration tests ---

test("native goals take precedence over legacy runtime goals with same ID", async () => {
  const files: Record<string, string> = {
    // Legacy runtime goal
    "/fixture/LegacyRuntime/goals/state/shared-goal.json": JSON.stringify({ id: "shared-goal", title: "Legacy Title", status: "running", controller_pid: 100 }),
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    // Native goal with same ID
    "/native-rt/goals/done/shared-goal.md": `---
title: Native Title
repo/workdir: /fixture/repo
dependencies:
---

Native version.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
    "/native-rt/runs/shared-goal/result.json": JSON.stringify({ goal_id: "shared-goal", success: true }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  const goal = snapshot.goals.find((g) => g.goal_id === "shared-goal");
  assert.ok(goal);
  // Native takes precedence — status should be "completed" not "running"
  assert.equal(goal?.status, "completed");
  assert.equal(goal?.title, "Native Title");
  // Source should be native-runner
  assert.equal(goal?.sources.some((s) => s.note === "native-runner"), true);
});

test("legacy goals are explicitly labelled when no native override exists", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/legacy-only.json": JSON.stringify({ id: "legacy-only", title: "Legacy", status: "ready" }),
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  const goal = snapshot.goals.find((g) => g.goal_id === "legacy-only");
  assert.ok(goal);
  assert.equal(goal?.sources.some((s) => s.note === "legacy-runtime"), true);
});

test("native events appear in buildRuntimeTimeline", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/done/native-goal.md": `---
title: Native Event Goal
repo/workdir: /fixture/repo
dependencies:
---

Goal with events.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
    "/native-rt/runs/native-goal/result.json": JSON.stringify({ goal_id: "native-goal", success: true }),
    "/native-rt/runs/native-goal/events.jsonl": [
      JSON.stringify({ type: "goal.claimed", timestamp: "2026-08-05T09:00:00.000Z", summary: "Claimed" }),
      JSON.stringify({ type: "acceptance.passed", timestamp: "2026-08-05T09:10:00.000Z", summary: "Accepted" }),
      JSON.stringify({ type: "review.passed", timestamp: "2026-08-05T09:20:00.000Z", summary: "Reviewed" }),
    ].join("\n"),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const timeline = await buildTimeline(roots, ada, snapshot);

  // Should include native events
  const nativeEvents = timeline.events.filter((e) => e.goal_id === "native-goal" && e.id.startsWith("native:"));
  assert.ok(nativeEvents.length >= 3, `Expected >= 3 native events, got ${nativeEvents.length}`);
  assert.equal(nativeEvents.some((e) => e.type === "goal.claimed"), true);
  assert.equal(nativeEvents.some((e) => e.type === "acceptance.passed"), true);
  assert.equal(nativeEvents.some((e) => e.type === "review.passed"), true);
});

test("native-only goal does not read or warn about missing legacy run directory", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/done/native-only.md": nativeGoal("Native Only"),
    "/native-rt/runs/native-only/result.json": JSON.stringify({ goal_id: "native-only", success: true }),
    "/native-rt/runs/native-only/events.jsonl": JSON.stringify({
      type: "goal.completed",
      timestamp: "2026-08-05T09:20:00.000Z",
      summary: "Native terminal evidence",
    }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const timeline = await buildTimeline(roots, ada, snapshot);

  assert.equal(timeline.events.some((event) => event.id === "native:native-only:events.jsonl:1"), true);
  assert.equal(timeline.warnings.some((warning) => warning.source.includes("/fixture/LegacyRuntime/runs/native-only")), false);
});

test("runner-emitted native event types are visible with deterministic severities", async () => {
  const runnerEventTypes = [
    "acceptance.failed",
    "acceptance.passed",
    "acceptance.started",
    "agent.started",
    "contract.failed",
    "control_plane.failed",
    "controller.lock_recovered",
    "deploy.ready",
    "goal.blocked",
    "goal.claimed",
    "goal.completed",
    "goal.failed",
    "goal.ready",
    "goal.shipped",
    "implementation.failed",
    "integrity.failed",
    "integrity.quarantined",
    "integrity.recovered",
    "migration.historical_done",
    "model.requested",
    "planner.failed",
    "promotion.blocked",
    "promotion.failed",
    "promotion.skipped",
    "quarantine.failed",
    "review.failed",
    "review.passed",
    "review.started",
    "runner.failed",
    "scope.failed",
    "shipping.failed",
    "shipping.started",
    "terminal_move.failed",
    "tool.completed",
    "tool.started",
    "worktree.failed",
  ] as const;
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/done/native-events.md": nativeGoal("Native Events"),
    "/native-rt/runs/native-events/result.json": JSON.stringify({ goal_id: "native-events", success: true }),
    "/native-rt/runs/native-events/events.jsonl": runnerEventTypes.map((type, index) => JSON.stringify({
      type,
      timestamp: `2026-08-05T09:${String(index).padStart(2, "0")}:00.000Z`,
      summary: type,
      metadata: { terminal: type === "goal.completed" },
    })).join("\n"),
    "/native-rt/controller-events.jsonl": JSON.stringify({
      type: "controller.warning",
      timestamp: "2026-08-05T10:00:00.000Z",
      summary: "Controller warning",
      metadata: { goal_id: "native-events", terminal: false },
    }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const timeline = await buildTimeline(roots, ada, snapshot);
  const visibleTypes = new Set(timeline.events.map((event) => event.type));

  for (const type of [...runnerEventTypes, "controller.warning"] as const) {
    assert.equal(visibleTypes.has(type), true, `missing ${type}`);
  }
  assert.equal(timeline.events.find((event) => event.type === "integrity.failed")?.severity, "critical");
  assert.equal(timeline.events.find((event) => event.type === "control_plane.failed")?.severity, "critical");
  assert.equal(timeline.events.find((event) => event.type === "promotion.failed")?.severity, "warning");
  assert.equal(timeline.events.find((event) => event.type === "promotion.blocked")?.severity, "warning");
  assert.equal(timeline.events.find((event) => event.type === "promotion.skipped")?.severity, "info");
  assert.equal(timeline.events.find((event) => event.type === "integrity.recovered")?.severity, "info");
  assert.equal(timeline.events.find((event) => event.type === "migration.historical_done")?.severity, "info");
  assert.equal(timeline.events.find((event) => event.type === "controller.warning")?.goal_id, "native-events");
});

test("native metadata keeps operational evidence and redacts private payloads", async () => {
  const secret = "sk-nativeMetadata123456789";
  const privatePath = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops/private.txt";
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/done/native-metadata.md": nativeGoal("Native Metadata"),
    "/native-rt/runs/native-metadata/result.json": JSON.stringify({ goal_id: "native-metadata", success: true }),
    "/native-rt/runs/native-metadata/events.jsonl": [
      JSON.stringify({
        type: "promotion.failed",
        timestamp: "2026-08-05T09:10:00.000Z",
        summary: "Fresh checkout preparation failed",
        metadata: {
          reason: "checkout_failed",
          state: "staged",
          states: ["staged", "ready"],
          terminal: false,
          goal_id: "native-metadata",
          branch: "feat/native-metadata",
          base_ref: "origin/main",
          dependency_ids: ["parent-a", "parent-b"],
          blocker_count: 2,
          changed_count: 4,
          terminal_state: "failed",
          success: false,
          evidence_sha256: "abc123def456",
          commit_sha: "0123456789abcdef0123456789abcdef01234567",
          pr_number: 12,
          deployment_id: "dpl_123456",
          sha256: "def456abc123",
          worktree_path_hash: "hash-without-path",
          prompt: `private prompt ${secret}`,
          customer_name: "Private Customer",
          argv: ["git", "status"],
          url: `https://example.test/callback?token=${secret}`,
        },
      }),
      JSON.stringify({
        type: "control_plane.failed",
        timestamp: "2026-08-05T09:11:00.000Z",
        summary: "Git control-plane fingerprint changed",
        metadata: {
          reason: `token ${secret}`,
          state: `opened ${privatePath}`,
          terminal: false,
        },
      }),
    ].join("\n"),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const timeline = await buildTimeline(roots, ada, snapshot);
  const promotion = timeline.events.find((event) => event.type === "promotion.failed");
  const controlPlane = timeline.events.find((event) => event.type === "control_plane.failed");
  assert.ok(promotion);
  assert.ok(controlPlane);

  assert.equal(promotion.metadata.reason, "checkout_failed");
  assert.equal(promotion.metadata.state, "staged");
  assert.equal(promotion.metadata.states, "staged,ready");
  assert.equal(promotion.metadata.terminal, false);
  assert.equal(promotion.metadata.goal_id, "native-metadata");
  assert.equal(promotion.metadata.branch, "feat/native-metadata");
  assert.equal(promotion.metadata.base_ref, "origin/main");
  assert.equal(promotion.metadata.dependency_ids, "parent-a,parent-b");
  assert.equal(promotion.metadata.blocker_count, 2);
  assert.equal(promotion.metadata.changed_count, 4);
  assert.equal(promotion.metadata.terminal_state, "failed");
  assert.equal(promotion.metadata.success, false);
  assert.equal(promotion.metadata.evidence_sha256, "abc123def456");
  assert.equal(promotion.metadata.commit_sha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(promotion.metadata.pr_number, 12);
  assert.equal(promotion.metadata.deployment_id, "dpl_123456");
  assert.equal(promotion.metadata.sha256, "def456abc123");
  assert.equal(promotion.metadata.worktree_path_hash, "hash-without-path");
  assert.equal(controlPlane.metadata.reason, "[redacted]");
  assert.equal(controlPlane.metadata.state, "[redacted]");

  const serialized = JSON.stringify(timeline);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(privatePath), false);
  assert.equal(serialized.includes("Private Customer"), false);
  assert.equal(serialized.includes("private prompt"), false);
  assert.equal(serialized.includes("git\",\"status"), false);
});

test("native runtime root is not treated as valid code worktree", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/ready/root-worktree-goal.md": `---
title: Bad Worktree Goal
repo/workdir: /native-rt
dependencies:
---

Goal pointing to runtime root.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  const goal = snapshot.goals.find((g) => g.goal_id === "root-worktree-goal");
  assert.ok(goal);
  // Worktree pointing to nativeRuntimeRoot should be rejected
  assert.equal(goal?.worktree, null);
});

test("standalone native adapter rejects forbidden worktree roots with warning", async () => {
  const forbidden = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops";
  const files: Record<string, string> = {
    "/native-rt/goals/ready/forbidden-worktree.md": `---
title: Forbidden Worktree
repo/workdir: ${forbidden}
dependencies:
---

Goal pointing to forbidden repo.
`,
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/home/phillip_downs/.hermes/mission-control-worktrees"],
    forbiddenWorktreeRoots: [forbidden],
  };

  const result = await readNativeGoalState(roots, fullAdapters(files));
  const goal = result.goals.find((g) => g.goal_id === "forbidden-worktree");
  assert.ok(goal);
  assert.equal(goal?.worktree, null);
  assert.equal(result.warnings.some((warning) => warning.source === "/native-rt/goals/ready/forbidden-worktree.md" && warning.message.includes("Git was not executed")), true);
  assert.equal(JSON.stringify(result).includes(forbidden), false);
});

test("standalone native adapter rejects symlinked forbidden worktree before Git", async () => {
  const symlink = "/home/phillip_downs/.hermes/mission-control-worktrees/repo-link";
  const forbidden = "/home/phillip_downs/Documents/GitHub/reliable-tradies-ops";
  const files: Record<string, string> = {
    "/native-rt/goals/ready/symlink-forbidden.md": `---
title: Symlink Forbidden Worktree
repo/workdir: ${symlink}
dependencies:
---

Goal pointing through an allowed symlink to a forbidden repo.
`,
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/home/phillip_downs/.hermes/mission-control-worktrees"],
    forbiddenWorktreeRoots: [forbidden],
  };

  let gitCalls = 0;
  const adapters: RuntimeAdapters = {
    fs: {
      ...memfs(files),
      async realpath(filePath: string) {
        if (filePath === symlink) return forbidden;
        return filePath;
      },
    },
    command: {
      async execFile(file, args) {
        if (file === "git") gitCalls += 1;
        return stubCommand().execFile(file, args);
      },
    },
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  };

  const result = await readNativeGoalState(roots, adapters);
  const goal = result.goals.find((g) => g.goal_id === "symlink-forbidden");
  const serialized = JSON.stringify(result);

  assert.ok(goal);
  assert.equal(goal?.worktree, null);
  assert.equal(gitCalls, 0);
  assert.equal(serialized.includes(symlink), false);
  assert.equal(serialized.includes(forbidden), false);
  assert.equal(result.warnings.some((warning) => warning.message.includes("forbidden roots") && warning.message.includes("Git was not executed")), true);
});

test("native rejected worktree marker is absent from snapshot evidence and timeline", async () => {
  const sensitive = "/fixture/SECRET_REJECTED_WORKTREE_MARKER";
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/ready/sensitive-worktree.md": `---
title: Sensitive Worktree
repo/workdir: ${sensitive}
dependencies:
---

Goal pointing to rejected worktree.
`,
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const timeline = await buildTimeline(roots, ada, snapshot);
  assert.equal(JSON.stringify({ snapshot, timeline }).includes("SECRET_REJECTED_WORKTREE_MARKER"), false);
  assert.equal(snapshot.source_warnings.some((warning) => warning.source === "/native-rt/goals/ready/sensitive-worktree.md" && warning.message.includes("Git was not executed")), true);
});

test("malformed native goal file surfaces explicit warning", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/ready/bad-goal.md": "not yaml at all --- just garbage",
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  // Should warn about malformed native goal
  assert.equal(
    snapshot.source_warnings.some((w) => w.message.includes("malformed native goal")),
    true,
    `Expected malformed warning, got: ${JSON.stringify(snapshot.source_warnings)}`,
  );
});

test("unclosed native frontmatter is malformed even with plausible fields", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/ready/unclosed-frontmatter.md": `---
title: Plausible Goal
repo/workdir: /fixture/repo
dependencies:

Plausible body.

## Allowed files

- \`test.txt\`

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const nativeState = await readNativeGoalState(roots, fullAdapters(files));
  assert.equal(nativeState.goals.some((goal) => goal.goal_id === "unclosed-frontmatter"), false);
  assert.equal(nativeState.warnings.some((warning) => warning.message.includes("malformed native goal")), true);

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  assert.equal(snapshot.goals.some((goal) => goal.goal_id === "unclosed-frontmatter"), false);
  assert.equal(snapshot.source_warnings.some((warning) => warning.message.includes("malformed native goal")), true);
});

test("ready native dependency blockers remain non-terminal and visible", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/ready/aaa-blocked.md": `---
title: Blocked Native
repo/workdir: /fixture/repo
dependencies: missing-parent
---

Blocked native goal.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
    "/native-rt/goals/ready/zzz-runnable.md": nativeGoal("Runnable Native"),
    "/native-rt/goals/done/mismatch-parent.md": nativeGoal("Mismatch Parent"),
    "/native-rt/runs/mismatch-parent/result.json": JSON.stringify({ goal_id: "other-parent", success: true }),
    "/native-rt/goals/ready/mismatch-blocked.md": `---
title: Mismatch Blocked
repo/workdir: /fixture/repo
dependencies: mismatch-parent
---

Blocked native goal.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
    "/native-rt/runs/aaa-blocked/events.jsonl": JSON.stringify({
      type: "goal.blocked",
      timestamp: "2026-08-05T09:01:00.000Z",
      summary: "Ready goal is waiting for dependencies",
      metadata: { blocker_ids: ["missing-parent"], terminal: false },
    }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const blocked = snapshot.goals.find((goal) => goal.goal_id === "aaa-blocked");
  const mismatchBlocked = snapshot.goals.find((goal) => goal.goal_id === "mismatch-blocked");
  const runnable = snapshot.goals.find((goal) => goal.goal_id === "zzz-runnable");

  assert.ok(blocked);
  assert.equal(blocked?.status, "ready");
  assert.equal(blocked?.queue_state, "ready");
  assert.deepEqual(blocked?.dependency_ids, ["missing-parent"]);
  assert.deepEqual(blocked?.blocker_ids, ["missing-parent"]);
  assert.equal(blocked?.sources.some((source) => source.note?.includes("native-dependency-blocked:missing-parent")), true);
  assert.ok(mismatchBlocked);
  assert.deepEqual(mismatchBlocked?.blocker_ids, ["mismatch-parent"]);
  assert.equal(mismatchBlocked?.sources.some((source) => source.note?.includes("native-dependency-blocked:mismatch-parent")), true);
  assert.ok(runnable);
  assert.deepEqual(runnable?.blocker_ids, []);

  const timeline = await buildTimeline(roots, ada, snapshot);
  assert.equal(timeline.events.some((event) => event.goal_id === "aaa-blocked" && event.type === "goal.blocked"), true);
  assert.equal(timeline.events.some((event) => event.goal_id === "aaa-blocked" && event.type === "goal.failed"), false);
  assert.equal(timeline.events.some((event) => event.goal_id === "aaa-blocked" && event.type === "goal.completed"), false);
});

test("native dependency aliases and list forms match runner parsing", async () => {
  const files: Record<string, string> = {
    "/native-rt/goals/ready/depends-on-scalar.md": nativeGoal("Depends On Scalar").replace("dependencies:\n", "depends_on: parent-a, parent-b\n"),
    "/native-rt/goals/ready/dependency-ids-list.md": nativeGoal("Dependency Ids List").replace("dependencies:\n", "dependency_ids:\n  - parent-c\n  - parent-d\n"),
    "/native-rt/goals/ready/dependencies-inline-list.md": nativeGoal("Dependencies Inline List").replace("dependencies:\n", "dependencies: [parent-e, parent-f]\n"),
    "/native-rt/goals/done/parent-a.md": nativeGoal("Parent A"),
    "/native-rt/runs/parent-a/result.json": JSON.stringify({ goal_id: "parent-a", success: true }),
    "/native-rt/goals/done/parent-c.md": nativeGoal("Parent C"),
    "/native-rt/runs/parent-c/result.json": JSON.stringify({ goal_id: "parent-c", success: true }),
    "/native-rt/goals/done/parent-e.md": nativeGoal("Parent E"),
    "/native-rt/runs/parent-e/result.json": JSON.stringify({ goal_id: "parent-e", success: true }),
  };
  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const result = await readNativeGoalState(roots, fullAdapters(files));
  assert.deepEqual(result.goals.find((goal) => goal.goal_id === "depends-on-scalar")?.dependency_ids, ["parent-a", "parent-b"]);
  assert.deepEqual(result.goals.find((goal) => goal.goal_id === "depends-on-scalar")?.blocker_ids, ["parent-b"]);
  assert.deepEqual(result.goals.find((goal) => goal.goal_id === "dependency-ids-list")?.dependency_ids, ["parent-c", "parent-d"]);
  assert.deepEqual(result.goals.find((goal) => goal.goal_id === "dependency-ids-list")?.blocker_ids, ["parent-d"]);
  assert.deepEqual(result.goals.find((goal) => goal.goal_id === "dependencies-inline-list")?.dependency_ids, ["parent-e", "parent-f"]);
  assert.deepEqual(result.goals.find((goal) => goal.goal_id === "dependencies-inline-list")?.blocker_ids, ["parent-f"]);
});

test("native lock PID is surfaced in snapshot", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/running/locked-goal.md": `---
title: Locked Goal
repo/workdir: /fixture/repo
dependencies:
---

Goal with lock.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`,
    "/native-rt/controller.lock": JSON.stringify({ goal_id: "locked-goal", pid: 42, proc_start_ticks: 1000 }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  const goal = snapshot.goals.find((g) => g.goal_id === "locked-goal");
  assert.ok(goal);
  assert.equal(goal?.controller_lock?.pid, 42);
  assert.equal(goal?.controller_pid, 42);
});

test("native ready and running queue state is not overwritten by legacy queue global", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": JSON.stringify({ status: "paused" }),
    "/native-rt/goals/ready/native-ready.md": nativeGoal("Native Ready"),
    "/native-rt/goals/running/native-running.md": nativeGoal("Native Running"),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  assert.equal(snapshot.goals.find((g) => g.goal_id === "native-ready")?.queue_state, "ready");
  assert.equal(snapshot.goals.find((g) => g.goal_id === "native-running")?.queue_state, "running");
});

test("legacy-only goal cannot acquire native events by matching ID alone", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/legacy-only.json": JSON.stringify({ id: "legacy-only", title: "Legacy", status: "ready" }),
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/runs/legacy-only/events.jsonl": [
      JSON.stringify({ type: "goal.completed", timestamp: "2026-08-05T09:20:00.000Z", summary: "Native event should not attach" }),
    ].join("\n"),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  const timeline = await buildTimeline(roots, ada, snapshot);
  assert.equal(timeline.events.some((event) => event.id.startsWith("native:legacy-only:")), false);
});

test("native terminal markdown without matching result is unknown and non-synthetic", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/done/done-without-result.md": nativeGoal("Done Without Result"),
    "/native-rt/goals/failed/failed-without-result.md": nativeGoal("Failed Without Result"),
    "/native-rt/goals/done/mismatched-result.md": nativeGoal("Mismatched Result"),
    "/native-rt/runs/mismatched-result/result.json": JSON.stringify({ goal_id: "mismatched-result", success: false }),
    "/native-rt/goals/done/mismatched-goal-id-result.md": nativeGoal("Mismatched Goal Id Result"),
    "/native-rt/runs/mismatched-goal-id-result/result.json": JSON.stringify({ goal_id: "other-goal", success: true }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const ada = fullAdapters(files);
  const snapshot = await buildRuntimeSnapshot(roots, ada);
  for (const goalId of ["done-without-result", "failed-without-result", "mismatched-result", "mismatched-goal-id-result"]) {
    const goal = snapshot.goals.find((g) => g.goal_id === goalId);
    assert.ok(goal, `missing ${goalId}`);
    assert.equal(goal?.status, "unknown");
    assert.equal(goal?.sources.some((source) => source.status === "warning" && source.note?.startsWith("native-terminal-result")), true);
  }
  assert.equal(snapshot.source_warnings.filter((warning) => warning.message.includes("native terminal result")).length, 4);

  const timeline = await buildTimeline(roots, ada, snapshot);
  assert.equal(timeline.events.some((event) => event.goal_id === "done-without-result" && event.type === "goal.completed"), false);
  assert.equal(timeline.events.some((event) => event.goal_id === "failed-without-result" && event.type === "goal.failed"), false);
  assert.equal(timeline.events.some((event) => event.goal_id === "mismatched-result" && (event.type === "goal.completed" || event.type === "goal.failed")), false);
  assert.equal(timeline.events.some((event) => event.goal_id === "mismatched-goal-id-result" && event.type === "goal.completed"), false);
});

test("valid native terminal results are cited as terminal evidence", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/goals/done/done-with-result.md": nativeGoal("Done With Result"),
    "/native-rt/goals/failed/failed-with-result.md": nativeGoal("Failed With Result"),
    "/native-rt/runs/done-with-result/result.json": JSON.stringify({ goal_id: "done-with-result", success: true }),
    "/native-rt/runs/failed-with-result/result.json": JSON.stringify({ goal_id: "failed-with-result", success: false }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  for (const [goalId, expectedStatus] of [["done-with-result", "completed"], ["failed-with-result", "failed"]] as const) {
    const goal = snapshot.goals.find((g) => g.goal_id === goalId);
    assert.ok(goal, `missing ${goalId}`);
    assert.equal(goal.status, expectedStatus);
    assert.deepEqual(goal.sources.find((source) => source.note === "native-terminal-result"), {
      source: `/native-rt/runs/${goalId}/result.json`,
      timestamp: "2026-08-05T09:59:00.000Z",
      status: "ok",
      note: "native-terminal-result",
    });
    assert.equal(goal.sources.some((source) => source.source === `/native-rt/goals/${expectedStatus === "completed" ? "done" : "failed"}/${goalId}.md` && source.note === "native-runner"), true);
  }
});

test("malformed native controller lock is visible warning evidence", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/native-rt/controller.lock": "{not json",
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  const lockGoal = snapshot.goals.find((goal) => goal.goal_id === "unknown-lock");
  assert.ok(lockGoal);
  assert.equal(lockGoal?.status, "unknown");
  assert.equal(lockGoal?.controller_lock?.invalid, true);
  assert.equal(lockGoal?.sources.some((source) => source.note === "controller-lock-invalid" && source.status === "warning"), true);
  assert.equal(snapshot.source_warnings.some((warning) => warning.message.includes("controller lock invalid")), true);
});

test("native controller lock rejects PID reuse via proc start ticks", async () => {
  const files: Record<string, string> = {
    "/fixture/LegacyRuntime/goals/state/queue-runner-status.json": "{}",
    "/fixture/proc/42/stat": procStat(42, "python3", 1, 2000),
    "/native-rt/goals/running/reused-pid.md": nativeGoal("Reused PID"),
    "/native-rt/controller.lock": JSON.stringify({ goal_id: "reused-pid", pid: 42, proc_start_ticks: 1000 }),
  };

  const roots: RuntimeRoots = {
    procRoot: "/fixture/proc",
    chatDevRoot: "/fixture/LegacyRuntime",
    repoRoot: "/fixture/repo",
    nativeRuntimeRoot: "/native-rt",
    allowedWorktreeRoots: ["/fixture/repo"],
  };

  const snapshot = await buildRuntimeSnapshot(roots, fullAdapters(files));
  const goal = snapshot.goals.find((g) => g.goal_id === "reused-pid");
  assert.equal(goal?.controller_lock?.live, false);
  assert.equal(goal?.controller_lock?.stale, true);
});

// --- Helpers ---

function nativeGoal(title: string) {
  return `---
title: ${title}
repo/workdir: /fixture/repo
dependencies:
---

${title}.

## Acceptance

\`\`\`bash
exit 0
\`\`\`
`;
}

function procStat(pid: number, name: string, ppid: number, starttime: number) {
  return `${pid} (${name}) S ${ppid} 0 0 0 0 0 0 0 0 0 5 6 0 0 20 0 1 0 ${starttime} 0 0`;
}

function memfs(files: Record<string, string>): FsAdapter {
  return {
    async readFile(filePath: string): Promise<string> {
      if (!(filePath in files)) throw new Error(`missing ${filePath}`);
      return files[filePath];
    },
    async readdir(dirPath: string): Promise<string[]> {
      const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
      if (!Object.keys(files).some((file) => file.startsWith(prefix))) throw new Error(`missing ${dirPath}`);
      return [...new Set(Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0])
        .filter(Boolean))];
    },
    async stat(filePath: string): Promise<{ mtimeMs: number; isDirectory(): boolean; isFile(): boolean }> {
      if (!(filePath in files) && !Object.keys(files).some((file) => file.startsWith(`${filePath}/`))) throw new Error(`missing ${filePath}`);
      return { mtimeMs: Date.parse("2026-08-05T09:59:00.000Z"), isDirectory: () => !path.extname(filePath), isFile: () => Boolean(path.extname(filePath)) };
    },
  };
}

function stubCommand(): CommandAdapter {
  return {
    async execFile(file: string, args: readonly string[]) {
      if (file === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { ok: true, stdout: "feat/test\n", stderr: "", code: 0 };
      if (file === "git" && args[0] === "rev-parse") return { ok: true, stdout: "abc123\n", stderr: "", code: 0 };
      if (file === "git" && args[0] === "status") return { ok: true, stdout: "", stderr: "", code: 0 };
      if (file === "git" && args[0] === "remote") return { ok: true, stdout: "origin\n", stderr: "", code: 0 };
      if (file === "systemctl") return { ok: true, stdout: "", stderr: "", code: 0 };
      return { ok: false, stdout: "", stderr: "unsupported", code: 1 };
    },
  };
}

function fullAdapters(files: Record<string, string>): RuntimeAdapters {
  return {
    fs: memfs(files),
    command: stubCommand(),
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  };
}
