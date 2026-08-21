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

  // Apply bounds to arrays
  const processes = snapshot.processes.slice(0, limit);
  const goals = snapshot.goals.slice(0, limit);
  const services = snapshot.services.slice(0, limit);
  const worktrees = snapshot.worktrees.slice(0, limit);

  return NextResponse.json({
    timestamp: snapshot.timestamp,
    roots: snapshot.roots,
    processes,
    goals,
    services,
    worktrees,
    source_warnings: snapshot.source_warnings.slice(0, MAX_LIMIT),
    // Metadata for bounded response
    meta: {
      total_processes: snapshot.processes.length,
      total_goals: snapshot.goals.length,
      total_services: snapshot.services.length,
      total_worktrees: snapshot.worktrees.length,
      limit,
      has_more:
        snapshot.processes.length > limit ||
        snapshot.goals.length > limit ||
        snapshot.services.length > limit ||
        snapshot.worktrees.length > limit,
    },
  });
}
