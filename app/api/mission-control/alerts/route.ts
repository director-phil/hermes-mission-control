import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";
import { buildRuntimeAlerts, buildRuntimeTimeline } from "@/lib/runtime-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await buildRuntimeSnapshot();
  const timeline = await buildRuntimeTimeline(undefined, undefined, snapshot);
  return NextResponse.json(buildRuntimeAlerts(snapshot, timeline));
}
