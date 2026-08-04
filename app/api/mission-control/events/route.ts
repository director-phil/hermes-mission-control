import { NextResponse } from "next/server";
import { runtimeToAuditEvents } from "@/lib/event-audit";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";
import { buildRuntimeTimeline } from "@/lib/runtime-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await buildRuntimeSnapshot();
  const timeline = await buildRuntimeTimeline(undefined, undefined, snapshot);
  return NextResponse.json({
    ...runtimeToAuditEvents(timeline.events),
    timeline,
  });
}
