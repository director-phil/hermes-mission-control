import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";
import { buildRuntimeAlerts, buildRuntimeTimeline } from "@/lib/runtime-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ goalId: string }> },
) {
  const { goalId } = await params;
  const snapshot = await buildRuntimeSnapshot();
  const timeline = await buildRuntimeTimeline(undefined, undefined, snapshot);
  const alerts = buildRuntimeAlerts(snapshot, timeline);
  return NextResponse.json({
    timestamp: snapshot.timestamp,
    goal: snapshot.goals.find((goal) => goal.goal_id === goalId) ?? null,
    processes: snapshot.processes.filter((process) => process.owner_goal_id === goalId),
    events: timeline.events.filter((event) => event.goal_id === goalId),
    alerts: alerts.alerts.filter((alert) => alert.goal_id === goalId),
  });
}
