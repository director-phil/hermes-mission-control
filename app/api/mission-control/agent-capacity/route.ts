import { NextResponse } from "next/server";
import { buildRuntimeSnapshot, isProvenHermesAgent } from "@/lib/runtime-truth";

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

  // Only include processes with proven Hermes identity as agents
  // Exclude "unrelated" and generic systemd_service entries
  const owned = snapshot.processes.filter((process) => isProvenHermesAgent(process));

  // Apply bounds to agent array
  const agents = owned.slice(0, limit).map((process) => ({
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
  }));

  // Build breakdown (only for owned/agent processes)
  const breakdown = owned.reduce<Record<string, number>>((acc, process) => {
    acc[process.role] = (acc[process.role] ?? 0) + 1;
    return acc;
  }, {});

  const activeAgents = owned.filter(
    (process) => Boolean(process.owner_goal_id || process.service_unit)
  ).length;

  return NextResponse.json({
    timestamp: snapshot.timestamp,
    global_status: snapshot.source_warnings.length > 0 ? "unknown" : "observed",
    agents,
    total_agents: owned.length,
    active_agents: activeAgents,
    breakdown,
    // Metadata for bounded response
    meta: {
      total_processes: snapshot.processes.length,
      total_agents: owned.length,
      limit,
      has_more: owned.length > limit,
    },
  });
}
