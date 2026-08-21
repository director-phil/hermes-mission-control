import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";
import { buildRuntimeAlerts, buildRuntimeTimeline } from "@/lib/runtime-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TIMELINE_BOUNDS = {
  maxGoals: 40,
  maxEventFilesPerGoal: 2,
  maxRowsPerFile: 80,
  maxTotalEvents: 200,
  maxWarnings: 100,
} as const;

export async function GET(request: Request) {
  const limit = requestLimit(request);
  const runtimeSnapshot = await buildRuntimeSnapshot();
  const timelineResult = await buildRuntimeTimeline(undefined, undefined, runtimeSnapshot, TIMELINE_BOUNDS);
  const alerts = buildRuntimeAlerts(runtimeSnapshot, timelineResult);
  const processes = runtimeSnapshot.processes.slice(0, limit);
  const goals = runtimeSnapshot.goals.slice(0, limit);
  const events = timelineResult.events.slice(-limit);
  const alertList = alerts.alerts.slice(0, limit);

  return NextResponse.json({
    timestamp: runtimeSnapshot.timestamp,
    fleet: {
      timestamp: runtimeSnapshot.timestamp,
      processes,
      services: runtimeSnapshot.services.slice(0, limit),
      worktrees: runtimeSnapshot.worktrees.slice(0, limit),
      source_warnings: runtimeSnapshot.source_warnings.slice(0, limit),
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
      goals,
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
      timestamp: timelineResult.timestamp,
      events,
      warnings: timelineResult.warnings.slice(0, limit),
      summary: {
        events: events.length,
        warnings: timelineResult.warnings.length,
        latest: timelineResult.events.at(-1)?.timestamp ?? null,
        goals_scanned: timelineResult.metadata?.goals_scanned ?? runtimeSnapshot.goals.length,
        goals_available: timelineResult.metadata?.goals_available ?? runtimeSnapshot.goals.length,
        has_more_goals: timelineResult.metadata?.has_more_goals ?? false,
        has_more_events: Boolean(timelineResult.metadata?.has_more_events) || timelineResult.events.length > events.length,
      },
    },
    alerts: { ...alerts, alerts: alertList },
    meta: {
      total_processes: runtimeSnapshot.processes.length,
      total_goals: runtimeSnapshot.goals.length,
      total_services: runtimeSnapshot.services.length,
      events_returned: events.length,
      alerts_observed: alerts.alerts.length,
      limit,
      has_more:
        runtimeSnapshot.processes.length > limit ||
        runtimeSnapshot.goals.length > limit ||
        runtimeSnapshot.services.length > limit ||
        Boolean(timelineResult.metadata?.has_more_events) ||
        alerts.alerts.length > limit,
    },
  });
}

function requestLimit(request: Request) {
  const parsed = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), MAX_LIMIT) : DEFAULT_LIMIT;
}
