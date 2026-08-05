import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";
import { buildRuntimeAlerts, buildRuntimeTimeline } from "@/lib/runtime-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runtimeSnapshot = await buildRuntimeSnapshot();
  const timeline = await buildRuntimeTimeline(undefined, undefined, runtimeSnapshot);
  const alerts = buildRuntimeAlerts(runtimeSnapshot, timeline);

  return NextResponse.json({
    timestamp: runtimeSnapshot.timestamp,
    fleet: {
      timestamp: runtimeSnapshot.timestamp,
      processes: runtimeSnapshot.processes,
      services: runtimeSnapshot.services,
      worktrees: runtimeSnapshot.worktrees,
      source_warnings: runtimeSnapshot.source_warnings,
      summary: {
        processes: runtimeSnapshot.processes.length,
        controllers: runtimeSnapshot.processes.filter((process) => process.role === "controller").length,
        wrappers: runtimeSnapshot.processes.filter((process) => process.role === "wrapper").length,
        orphaned: runtimeSnapshot.processes.filter((process) => process.orphan).length,
        services: runtimeSnapshot.services.length,
      },
    },
    work: {
      timestamp: runtimeSnapshot.timestamp,
      goals: runtimeSnapshot.goals,
      summary: {
        total: runtimeSnapshot.goals.length,
        staged: runtimeSnapshot.goals.filter((goal) => goal.status === "staged").length,
        running: runtimeSnapshot.goals.filter((goal) => goal.status === "running").length,
        ready: runtimeSnapshot.goals.filter((goal) => goal.status === "ready").length,
        pending_surface_verification: runtimeSnapshot.goals.filter((goal) => goal.status === "changed_pending_surface_verification").length,
        terminal: runtimeSnapshot.goals.filter((goal) => goal.status === "completed" || goal.status === "failed").length,
        unknown: runtimeSnapshot.goals.filter((goal) => goal.status === "unknown").length,
        conflicted: runtimeSnapshot.goals.filter((goal) => goal.status === "conflicted").length,
      },
    },
    trace: {
      timestamp: timeline.timestamp,
      events: timeline.events,
      warnings: timeline.warnings,
      summary: {
        events: timeline.events.length,
        warnings: timeline.warnings.length,
        latest: timeline.events.at(-1)?.timestamp ?? null,
      },
    },
    alerts,
  });
}
