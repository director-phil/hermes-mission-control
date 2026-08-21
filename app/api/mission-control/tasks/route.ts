import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default and maximum limits for bounded responses
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;

  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed)) {
      limit = Math.min(Math.max(1, parsed), MAX_LIMIT);
    }
  }

  const snapshot = await buildRuntimeSnapshot();

  // Build tasks array with bounds
  const tasks = snapshot.goals.slice(0, limit).map((goal) => ({
    id: goal.goal_id,
    title: goal.title ?? goal.goal_id,
    status: goal.status,
    owner: goal.controller_pid ? `pid:${goal.controller_pid}` : "unknown",
    updated_at: goal.last_event_timestamp ?? goal.sources[0]?.timestamp ?? snapshot.timestamp,
    source: goal.sources[0]?.source ?? "unknown",
    priority: goal.blocker_ids.length > 0 ? "high" : "normal",
    evidence: goal.sources.slice(0, MAX_LIMIT), // Cap evidence array too
  }));

  const activeCount = snapshot.goals.filter((goal) => goal.status === "running" || goal.status === "ready").length;
  const criticalCount = snapshot.goals.filter((goal) => goal.blocker_ids.length > 0).length;

  return NextResponse.json({
    timestamp: snapshot.timestamp,
    total: snapshot.goals.length,
    active: activeCount,
    critical: criticalCount,
    sources: {
      goals: {
        status: snapshot.source_warnings.some((warning) => warning.source.includes("goals")) ? "unknown" : "ok",
        count: tasks.length,
        evidence: "Hermes native runtime goal state and run evidence",
      },
    },
    tasks,
    runbooks: [],
    // Metadata for bounded response
    meta: {
      total_goals: snapshot.goals.length,
      limit,
      has_more: snapshot.goals.length > limit,
    },
  });
}
