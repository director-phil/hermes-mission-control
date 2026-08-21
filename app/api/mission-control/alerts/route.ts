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
  const snapshot = await buildRuntimeSnapshot();
  const timelineResult = await buildRuntimeTimeline(undefined, undefined, snapshot, TIMELINE_BOUNDS);
  const observed = buildRuntimeAlerts(snapshot, timelineResult);
  const alerts = observed.alerts.slice(0, limit);
  return NextResponse.json({
    ...observed,
    alerts,
    meta: {
      alerts_observed: observed.alerts.length,
      alerts_returned: alerts.length,
      limit,
      has_more: observed.alerts.length > limit,
      timeline: timelineResult.metadata ?? null,
    },
  });
}

function requestLimit(request: Request) {
  const parsed = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), MAX_LIMIT) : DEFAULT_LIMIT;
}
