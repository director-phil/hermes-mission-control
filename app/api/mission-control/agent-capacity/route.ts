import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await buildRuntimeSnapshot();
  const owned = snapshot.processes.filter((process) => process.role !== "unrelated");
  const breakdown = owned.reduce<Record<string, number>>((acc, process) => {
    acc[process.role] = (acc[process.role] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    timestamp: snapshot.timestamp,
    global_status: snapshot.source_warnings.length > 0 ? "unknown" : "observed",
    agents: owned.map((process) => ({
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
    })),
    total_agents: owned.length,
    active_agents: owned.filter((process) => process.owner_goal_id || process.service_unit).length,
    breakdown,
  });
}
