/**
 * S1 → S2 — First View Operating Shell (overview endpoint)
 *
 * Aggregates all 8 first-view sections in parallel. System Health
 * uses live evidence (S2). Remaining sections use placeholders until
 * their respective slices are wired.
 */

import { NextResponse } from "next/server";
import { computeProductionTrust } from "@/lib/production-trust";
import { getEvents, getEventCounts, seedInitialEvents } from "@/lib/event-audit";

// Seed events on overview route import (ensures seed runs before any request)
seedInitialEvents();

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date().toISOString();

  const [systemHealth, agentCapacity, approvalsRequired, productionTrust,
          liveAgentOps, activeTasks, eventStream, researchIntelligence] =
    await Promise.allSettled([
      getSystemHealthData(),
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

/* ── S2: System Health Live Evidence ───────────────────────────── */

async function getSystemHealthData() {
  const now = new Date().toISOString();

  const [gb10_1, gb10_2, hermes, qdrant, railway, vercel, github, servicetitan, xero] =
    await Promise.allSettled([
      checkGB10(1),
      checkGB10(2),
      checkHermes(),
      checkQdrant(),
      checkRailway(),
      checkVercel(),
      checkGitHub(),
      checkServiceTitan(),
      checkXero(),
    ]);

  const systems = [
    { name: "GB10 #1", ...parseCheck(gb10_1) },
    { name: "GB10 #2", ...parseCheck(gb10_2) },
    { name: "Hermes", ...parseCheck(hermes) },
    { name: "Qdrant", ...parseCheck(qdrant) },
    { name: "Railway", ...parseCheck(railway) },
    { name: "Vercel", ...parseCheck(vercel) },
    { name: "GitHub", ...parseCheck(github) },
    { name: "ServiceTitan", ...parseCheck(servicetitan) },
    { name: "Xero", ...parseCheck(xero) },
  ];

  const globalStatus = determineGlobal(systems);

  return {
    status: globalStatus,
    label: globalStatus === "critical" ? "Critical dependency failure" :
           globalStatus === "warning" ? "Degraded systems detected" :
           globalStatus === "healthy" ? "All systems operational" :
           "Some systems unavailable",
    evidence_timestamp: now,
    systems,
  };
}

/* ── section fetchers ──────────────────────────────────────────── */

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
  return computeProductionTrust();
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
  const result = getEvents();
  const counts = getEventCounts();

  return {
    status: result.events.length > 0 ? "healthy" : "warning",
    label: result.events.length > 0
      ? `${result.filtered_count} active events`
      : "No active events",
    evidence_timestamp: new Date().toISOString(),
    total_events: result.total_count,
    filtered_events: result.filtered_count,
    severity_counts: counts,
    events: result.events.slice(0, 20), // Latest 20 for overview
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

/* ── Health check functions ────────────────────────────────────── */

async function checkGB10(num: number) {
  const host = num === 1 ? "gb10-1.local" : "gb10-2.local";
  const port = num === 1 ? 1234 : 1235;

  try {
    const { execSync } = require("child_process");
    const result = execSync(
      `timeout 3 ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no root@${host} "uptime" 2>&1`,
      { timeout: 5000 }
    );
    const uptime = result.toString().trim();
    return {
      status: "healthy" as const,
      metric: uptime || "up",
      last_checked: new Date().toISOString(),
    };
  } catch {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        return {
          status: "healthy" as const,
          metric: `${res.status} OK`,
          last_checked: new Date().toISOString(),
        };
      }
    } catch { /* ignore fallback */ }

    return {
      status: "pending" as const,
      metric: null,
      last_checked: new Date().toISOString(),
    };
  }
}

async function checkHermes() {
  try {
    const res = await fetch("http://localhost:1234/v1/models", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        status: "healthy" as const,
        metric: `${data.data?.length ?? 0} models loaded`,
        last_checked: new Date().toISOString(),
      };
    }
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkQdrant() {
  try {
    const res = await fetch("http://localhost:6333/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const text = await res.text();
      return {
        status: "healthy" as const,
        metric: text || "healthy",
        last_checked: new Date().toISOString(),
      };
    }
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkRailway() {
  try {
    const res = await fetch("https://railway.app/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { status: "healthy" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
    }
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkVercel() {
  try {
    const res = await fetch("https://vercel.com/docs/rest-api", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 401 || res.status === 403) {
      return { status: "healthy" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
    }
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkGitHub() {
  try {
    const res = await fetch("https://api.github.com/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        status: data.status === "major" ? "warning" as const : "healthy" as const,
        metric: data.status || "operational",
        last_checked: new Date().toISOString(),
      };
    }
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkServiceTitan() {
  try {
    const res = await fetch("https://auth.servicetitan.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: process.env.ST_CLIENT_ID || "",
        client_secret: process.env.ST_CLIENT_SECRET || "",
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) {
      return { status: "healthy" as const, metric: `${res.status} (auth endpoint reachable)`, last_checked: new Date().toISOString() };
    }
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkXero() {
  try {
    const res = await fetch("https://api.xero.com/timezones", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403) {
      return { status: "healthy" as const, metric: `${res.status} (auth required)`, last_checked: new Date().toISOString() };
    }
    if (res.ok) return { status: "healthy" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
    return { status: "warning" as const, metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending" as const, metric: null, last_checked: new Date().toISOString() };
  }
}

/* ── Helpers ───────────────────────────────────────────────────── */

function parseResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "fulfilled") return result.value;
  throw new Error(result.reason?.message ?? "Unknown error");
}

function parseCheck<T extends PromiseSettledResult<any>>(result: T): { status: string; metric: string | null; last_checked: string } {
  if (result.status === "rejected") {
    return { status: "critical", metric: String(result.reason?.message || "unreachable"), last_checked: new Date().toISOString() };
  }
  const data = result.value;
  return {
    status: data.status || "pending",
    metric: data.metric ?? null,
    last_checked: data.last_checked || new Date().toISOString(),
  };
}

function determineGlobal(systems: Array<{ status: string }>): string {
  const hasCritical = systems.some((s) => s.status === "critical");
  if (hasCritical) return "critical";
  const hasWarning = systems.some((s) => s.status === "warning");
  if (hasWarning) return "warning";
  const allPending = systems.every((s) => s.status === "pending");
  if (allPending) return "pending";
  return "healthy";
}
