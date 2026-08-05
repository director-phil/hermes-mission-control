import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await buildRuntimeSnapshot();
  const tasks = snapshot.goals.map((goal) => ({
    id: goal.goal_id,
    title: goal.title ?? goal.goal_id,
    status: goal.status,
    owner: goal.controller_pid ? `pid:${goal.controller_pid}` : "unknown",
    updated_at: goal.last_event_timestamp ?? goal.sources[0]?.timestamp ?? snapshot.timestamp,
    source: goal.sources[0]?.source ?? "unknown",
    priority: goal.blocker_ids.length > 0 ? "high" : "normal",
    evidence: goal.sources,
  }));

  return NextResponse.json({
    timestamp: snapshot.timestamp,
    total: tasks.length,
    active: tasks.filter((task) => task.status === "running" || task.status === "ready").length,
    critical: tasks.filter((task) => task.priority === "high").length,
    sources: {
      goals: {
        status: snapshot.source_warnings.some((warning) => warning.source.includes("goals")) ? "unknown" : "ok",
        count: tasks.length,
        evidence: "Hermes native runtime goal state and run evidence",
      },
    },
    tasks,
    runbooks: [],
  });
}
