import { NextResponse } from "next/server";
import { runtimeToAuditEvents } from "@/lib/event-audit";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";
import { buildRuntimeTimeline } from "@/lib/runtime-events";

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
  const timelineResult = await buildRuntimeTimeline(undefined, undefined, snapshot, {
    ...TIMELINE_BOUNDS,
    maxTotalEvents: Math.min(limit, TIMELINE_BOUNDS.maxTotalEvents),
  });
  const events = timelineResult.events.slice(-limit);
  const warnings = timelineResult.warnings.slice(0, limit);
  const timelineMetadata = timelineResult.metadata
    ? {
        ...timelineResult.metadata,
        events_returned: events.length,
        has_more_events: timelineResult.metadata.has_more_events || timelineResult.events.length > events.length,
      }
    : undefined;
  return NextResponse.json({
    ...runtimeToAuditEvents(events),
    timeline: { ...timelineResult, events, warnings, metadata: timelineMetadata },
    meta: {
      ...(timelineMetadata ?? {}),
      events_returned: events.length,
      warnings_returned: warnings.length,
      limit,
    },
  });
}

function requestLimit(request: Request) {
  const parsed = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), MAX_LIMIT) : DEFAULT_LIMIT;
}
