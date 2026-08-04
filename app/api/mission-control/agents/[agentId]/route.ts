import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const snapshot = await buildRuntimeSnapshot();
  const process = snapshot.processes.find((item) => String(item.pid) === agentId);
  if (!process) {
    return NextResponse.json({ error: `Unknown runtime process: ${agentId}` }, { status: 404 });
  }

  return NextResponse.json({
    agent: {
      id: String(process.pid),
      name: process.name,
      role: process.role,
      status: process.owner_goal_id || process.service_unit ? "owned" : "unowned",
      local: true,
      sessions: { active: 1, max: 1 },
      last_activity: process.evidence.timestamp,
      evidence: process.evidence.source,
      goal_id: process.owner_goal_id,
      service_unit: process.service_unit,
      argv_redacted: process.argv_redacted,
    },
    recent_activity: [],
    capacity: {
      utilization_pct: null,
      status_label: process.orphan ? "critical" : "observed",
      evidence: "capacity utilization unknown: no measured session or limit source",
    },
    dependencies: [
      { name: "process", status: "observed", evidence: process.evidence.source },
      { name: "owner", status: process.owner_goal_id || process.service_unit ? "observed" : "unknown", evidence: process.owner_goal_id ?? process.service_unit ?? "no owner source" },
    ],
  });
}
