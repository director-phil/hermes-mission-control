/**
 * S1 — First View Operating Shell (overview endpoint)
 *
 * Aggregates all 8 first-view sections in parallel. Uses real data where
 * live wiring exists, placeholder data with explicit labels where not yet
 * wired. All timestamps are evidence-based.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date().toISOString();

  const [systemHealth, agentCapacity, approvalsRequired, productionTrust,
          liveAgentOps, activeTasks, eventStream, researchIntelligence] =
    await Promise.allSettled([
      fetchSystemHealth(),
      fetchAgentCapacity(),
      fetchApprovalsRequired(),
      fetchProductionTrust(),
      fetchLiveAgentOps(),
      fetchActiveTasks(),
      fetchEventStream(),
      fetchResearchIntelligence(),
    ]);

  return NextResponse.json({
    timestamp: now,
    system_health: parseResult(systemHealth),
    agent_capacity: parseResult(agentCapacity),
    approvals_required: parseResult(approvalsRequired),
    production_trust: parseResult(productionTrust),
    live_agent_ops: parseResult(liveAgentOps),
    active_tasks: parseResult(activeTasks),
    event_stream: parseResult(eventStream),
    research_intelligence: parseResult(researchIntelligence),
  });
}

/* ── section fetchers ──────────────────────────────────────────── */

async function fetchSystemHealth() {
  return {
    status: "pending",
    label: "Pending live wiring (S2)",
    evidence_timestamp: null,
    systems: [
      { name: "GB10 #1", status: "pending", metric: null, last_checked: null },
      { name: "GB10 #2", status: "pending", metric: null, last_checked: null },
      { name: "Hermes", status: "pending", metric: null, last_checked: null },
      { name: "Qdrant", status: "pending", metric: null, last_checked: null },
      { name: "Railway", status: "pending", metric: null, last_checked: null },
      { name: "Vercel", status: "pending", metric: null, last_checked: null },
      { name: "GitHub", status: "pending", metric: null, last_checked: null },
      { name: "ServiceTitan", status: "pending", metric: null, last_checked: null },
      { name: "Xero", status: "pending", metric: null, last_checked: null },
    ],
  };
}

async function fetchAgentCapacity() {
  return {
    status: "pending",
    label: "Pending live wiring (S3)",
    evidence_timestamp: null,
    active_sessions: 0,
    breakdown: {
      running: 0,
      waiting: 0,
      blocked: 0,
      review: 0,
      completed: 0,
    },
  };
}

async function fetchApprovalsRequired() {
  return {
    status: "pending",
    label: "Pending live wiring (S4)",
    evidence_timestamp: null,
    count: 0,
    items: [],
  };
}

async function fetchProductionTrust() {
  return {
    status: "pending",
    label: "Pending live wiring (S6)",
    evidence_timestamp: null,
    trust_score: null,
    freshness: [],
    integrity: { score: null, mismatches: 0, last_recon: null },
    deployments: { railway: null, vercel: null },
  };
}

async function fetchLiveAgentOps() {
  return {
    status: "pending",
    label: "Pending live wiring (S3)",
    evidence_timestamp: null,
    agents: [],
  };
}

async function fetchActiveTasks() {
  return {
    status: "pending",
    label: "Pending live wiring (S5)",
    evidence_timestamp: null,
    count: 0,
    items: [],
  };
}

async function fetchEventStream() {
  return {
    status: "pending",
    label: "Pending live wiring (S7)",
    evidence_timestamp: null,
    events: [],
  };
}

async function fetchResearchIntelligence() {
  return {
    status: "pending",
    label: "Pending live wiring (S8)",
    evidence_timestamp: null,
    findings: [],
  };
}

/* ── helpers ───────────────────────────────────────────────────── */

function parseResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "fulfilled") return result.value;
  throw new Error(result.reason?.message ?? "Unknown error");
}
