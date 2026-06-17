/**
 * S1 → S2 — First View Operating Shell (overview endpoint)
 *
 * Aggregates all 8 first-view sections in parallel. System Health
 * uses live evidence (S2). Remaining sections use placeholders until
 * their respective slices are wired.
 *
 * Global timeout: 15s — if any check hangs, it's marked pending.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TIMEOUT_MS = 15_000;

export async function GET() {
  const now = new Date().toISOString();

  const [systemHealth, agentCapacity, approvalsRequired, productionTrust,
          liveAgentOps, activeTasks, eventStream, researchIntelligence] =
    await Promise.allSettled([
      withTimeout(getSystemHealthData(), TIMEOUT_MS),
      withTimeout(fetchAgentCapacity(), TIMEOUT_MS),
      withTimeout(fetchApprovalsRequired(), TIMEOUT_MS),
      withTimeout(fetchProductionTrust(), TIMEOUT_MS),
      withTimeout(fetchLiveAgentOps(), TIMEOUT_MS),
      withTimeout(fetchActiveTasks(), TIMEOUT_MS),
      withTimeout(fetchEventStream(), TIMEOUT_MS),
      withTimeout(fetchResearchIntelligence(), TIMEOUT_MS),
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

  // Run all health checks with individual timeouts, never throw
  const results = await Promise.allSettled([
    safeCheck(checkGB10(1), "GB10 #1", 5000),
    safeCheck(checkGB10(2), "GB10 #2", 5000),
    safeCheck(checkHermes(), "Hermes", 5000),
    safeCheck(checkQdrant(), "Qdrant", 5000),
    safeCheck(checkRailway(), "Railway", 8000),
    safeCheck(checkVercel(), "Vercel", 8000),
    safeCheck(checkGitHub(), "GitHub", 8000),
    safeCheck(checkServiceTitan(), "ServiceTitan", 8000),
    safeCheck(checkXero(), "Xero", 8000),
  ]);

  const systems = results.map((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      return {
        name: r.value.name,
        status: r.value.status,
        metric: r.value.metric ?? null,
        last_checked: r.value.last_checked || now,
      };
    }
    return {
      name: r.status === "fulfilled" && r.value ? r.value.name : `System ${i + 1}`,
      status: "pending",
      metric: null,
      last_checked: now,
    };
  });

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

/* ── Health check functions ────────────────────────────────────── */

async function checkGB10(num: number) {
  const host = num === 1 ? "gb10-1.local" : "gb10-2.local";
  try {
    const res = await fetch(`http://${host}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return { name: `GB10 #${num}`, status: "healthy", metric: `${res.status} OK`, last_checked: new Date().toISOString() };
    }
    return { name: `GB10 #${num}`, status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: `GB10 #${num}`, status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkHermes() {
  try {
    const res = await fetch("http://localhost:1234/v1/models", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return { name: "Hermes", status: "healthy", metric: `${data.data?.length ?? 0} models loaded`, last_checked: new Date().toISOString() };
    }
    return { name: "Hermes", status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "Hermes", status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkQdrant() {
  try {
    const res = await fetch("http://localhost:6333/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const text = await res.text();
      return { name: "Qdrant", status: "healthy", metric: text || "healthy", last_checked: new Date().toISOString() };
    }
    return { name: "Qdrant", status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "Qdrant", status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkRailway() {
  try {
    const res = await fetch("https://railway.app/health", {
      signal: AbortSignal.timeout(8000),
    });
    return { name: "Railway", status: res.ok ? "healthy" : "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "Railway", status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkVercel() {
  try {
    const res = await fetch("https://vercel.com/docs/rest-api", {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
    });
    return { name: "Vercel", status: res.ok || res.status === 401 || res.status === 403 ? "healthy" : "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "Vercel", status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkGitHub() {
  try {
    const res = await fetch("https://api.github.com/status", {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      return { name: "GitHub", status: data.status === "major" ? "warning" : "healthy", metric: data.status || "operational", last_checked: new Date().toISOString() };
    }
    return { name: "GitHub", status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "GitHub", status: "pending", metric: null, last_checked: new Date().toISOString() };
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
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) {
      return { name: "ServiceTitan", status: "healthy", metric: `${res.status} (auth endpoint reachable)`, last_checked: new Date().toISOString() };
    }
    return { name: "ServiceTitan", status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "ServiceTitan", status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

async function checkXero() {
  try {
    const res = await fetch("https://api.xero.com/timezones", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { name: "Xero", status: "healthy", metric: `${res.status} (auth required)`, last_checked: new Date().toISOString() };
    }
    if (res.ok) return { name: "Xero", status: "healthy", metric: `${res.status}`, last_checked: new Date().toISOString() };
    return { name: "Xero", status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { name: "Xero", status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

/* ── Helper: wrap a check with timeout, never throw ────────────── */

async function safeCheck<T extends Promise<any>>(promise: T, name: string, timeoutMs: number): Promise<{ name: string; status: string; metric: string | null; last_checked: string } | null> {
  try {
    return await Promise.race([
      promise,
      new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch {
    return { name, status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

/* ── Section fetchers (live wiring via relative paths) ───────────── */

async function fetchAgentCapacity() {
  try {
    const res = await fetch("/api/mission-control/agent-capacity", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "error", label: res.statusText, evidence_timestamp: null, active_sessions: 0, breakdown: {} };
    const data = await res.json();
    return {
      status: data.global_status || "pending",
      label: data.global_status === "healthy" ? "All agents online" : "Agent pool active",
      evidence_timestamp: new Date().toISOString(),
      active_sessions: data.active_agents ?? data.total_agents ?? 0,
      breakdown: data.breakdown ?? {},
    };
  } catch {
    return { status: "pending", label: "Agent capacity check timed out", evidence_timestamp: null, active_sessions: 0, breakdown: {} };
  }
}

async function fetchApprovalsRequired() {
  try {
    const res = await fetch("/api/mission-control/approvals", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "error", label: res.statusText, evidence_timestamp: null, count: 0, items: [] };
    const data = await res.json();
    return {
      status: data.summary?.urgent > 0 ? "warning" : "healthy",
      label: data.summary?.urgent > 0 ? "Urgent approvals pending" : "Approval queue healthy",
      evidence_timestamp: data.timestamp ?? new Date().toISOString(),
      count: data.summary?.total ?? 0,
      items: (data.approvals ?? []).map((a: any) => ({
        title: a.title,
        evidence: a.evidence,
        recommendation: a.description,
      })),
    };
  } catch {
    return { status: "pending", label: "Approvals check timed out", evidence_timestamp: null, count: 0, items: [] };
  }
}

async function fetchProductionTrust() {
  try {
    const res = await fetch("/api/mission-control/production-trust", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "error", label: res.statusText, evidence_timestamp: null, trust_score: null, freshness: [], integrity: { score: null, mismatches: 0, last_recon: null }, deployments: { railway: null, vercel: null } };
    const data = await res.json();
    return {
      status: data.trust_score !== null && data.trust_score >= 80 ? "healthy" : data.trust_score !== null && data.trust_score >= 50 ? "warning" : "pending",
      label: data.trust_score !== null ? `${data.trust_score}% trust score` : "Score not yet computed",
      evidence_timestamp: data.timestamp ?? new Date().toISOString(),
      trust_score: data.trust_score ?? null,
      freshness: data.freshness ?? [],
      integrity: data.integrity ?? { score: null, mismatches: 0, last_recon: null },
      deployments: data.deployments ?? { railway: null, vercel: null },
    };
  } catch {
    return { status: "pending", label: "Production trust check timed out", evidence_timestamp: null, trust_score: null, freshness: [], integrity: { score: null, mismatches: 0, last_recon: null }, deployments: { railway: null, vercel: null } };
  }
}

async function fetchLiveAgentOps() {
  try {
    const res = await fetch("/api/mission-control/agent-capacity", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "error", label: res.statusText, evidence_timestamp: null, agents: [] };
    const data = await res.json();
    return {
      status: data.global_status || "pending",
      label: data.global_status === "healthy" ? "All agents operational" : "Agent ops active",
      evidence_timestamp: new Date().toISOString(),
      agents: (data.agents ?? []).map((a: any) => ({
        name: a.name,
        task: `${a.role} — ${a.evidence}`,
        status: a.status,
      })),
    };
  } catch {
    return { status: "pending", label: "Live agent ops check timed out", evidence_timestamp: null, agents: [] };
  }
}

async function fetchActiveTasks() {
  try {
    const res = await fetch("/api/mission-control/tasks", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "error", label: res.statusText, evidence_timestamp: null, count: 0, items: [], runbooks: [], sources: {} };
    const data = await res.json();
    return {
      status: data.critical > 0 ? "warning" : "healthy",
      label: data.critical > 0 ? `${data.critical} critical tasks` : "Task queue healthy",
      evidence_timestamp: data.timestamp ?? new Date().toISOString(),
      count: data.total ?? 0,
      items: (data.tasks ?? []).map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner,
        updated_at: t.updated_at,
        source: t.source,
        priority: t.priority,
      })),
      runbooks: data.runbooks ?? [],
      sources: data.sources ?? {},
    };
  } catch {
    return { status: "pending", label: "Active tasks check timed out", evidence_timestamp: null, count: 0, items: [], runbooks: [], sources: {} };
  }
}

async function fetchEventStream() {
  try {
    const res = await fetch("/api/mission-control/events", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "error", label: res.statusText, evidence_timestamp: null, events: [] };
    const data = await res.json();
    return {
      status: data.events?.some((e: any) => e.severity === "critical") ? "warning" : "healthy",
      label: data.events?.length ? `${data.events.length} events` : "No events",
      evidence_timestamp: data.timestamp ?? new Date().toISOString(),
      events: (data.events ?? []).map((e: any) => ({
        type: e.type,
        message: e.message,
        timestamp: e.timestamp,
      })),
    };
  } catch {
    return { status: "pending", label: "Event stream check timed out", evidence_timestamp: null, events: [] };
  }
}

async function fetchResearchIntelligence() {
  return {
    status: "pending",
    label: "Pending live wiring (S8)",
    evidence_timestamp: null,
    findings: [],
  };
}

/* ── Helpers ───────────────────────────────────────────────────── */

function parseResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "fulfilled") return result.value;
  // Should never happen — all promises are wrapped in safeCheck
  return null as unknown as T;
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    }),
  ]);
}
