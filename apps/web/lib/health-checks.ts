/**
 * Shared health check utilities for Mission Control.
 * Extracted from system-health/route.ts to avoid Next.js Route export
 * conflicts (exports starting with get/post/head/delete/patch are
 * treated as route handlers).
 */

export type HealthStatus = "healthy" | "warning" | "critical" | "pending";

export interface HealthCheckResult {
  status: HealthStatus;
  metric: string | null;
  last_checked: string;
}

export interface SystemHealthData {
  status: HealthStatus;
  label: string;
  evidence_timestamp: string;
  systems: Array<{ name: string } & HealthCheckResult>;
}

/* ── Individual check functions ─────────────────────────────────── */

export async function checkGB10(num: number): Promise<HealthCheckResult> {
  const host = num === 1 ? "gb10-1.local" : "gb10-2.local";
  const port = num === 1 ? 1234 : 1235;

  try {
    const { execSync } = require("child_process");
    const result = execSync(
      `timeout 3 ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no root@${host} "uptime" 2>&1`,
      { timeout: 5000 }
    );
    const uptime = result.toString().trim();
    return { status: "healthy", metric: uptime || "up", last_checked: new Date().toISOString() };
  } catch {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        return { status: "healthy", metric: `${res.status} OK`, last_checked: new Date().toISOString() };
      }
    } catch { /* ignore fallback */ }
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkHermes(): Promise<HealthCheckResult> {
  try {
    const res = await fetch("http://localhost:1234/v1/models", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data: any = await res.json();
      return {
        status: "healthy",
        metric: `${data.data?.length ?? 0} models loaded`,
        last_checked: new Date().toISOString(),
      };
    }
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkQdrant(): Promise<HealthCheckResult> {
  try {
    const res = await fetch("http://localhost:6333/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const text = await res.text();
      return { status: "healthy", metric: text || "healthy", last_checked: new Date().toISOString() };
    }
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkRailway(): Promise<HealthCheckResult> {
  try {
    const res = await fetch("https://railway.app/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { status: "healthy", metric: `${res.status}`, last_checked: new Date().toISOString() };
    }
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkVercel(): Promise<HealthCheckResult> {
  try {
    const res = await fetch("https://vercel.com/docs/rest-api", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 401 || res.status === 403) {
      return { status: "healthy", metric: `${res.status}`, last_checked: new Date().toISOString() };
    }
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkGitHub(): Promise<HealthCheckResult> {
  try {
    const res = await fetch("https://api.github.com/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data: any = await res.json();
      return {
        status: data.status === "major" ? "warning" : "healthy",
        metric: data.status || "operational",
        last_checked: new Date().toISOString(),
      };
    }
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkServiceTitan(): Promise<HealthCheckResult> {
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
      return { status: "healthy", metric: `${res.status} (auth endpoint reachable)`, last_checked: new Date().toISOString() };
    }
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

export async function checkXero(): Promise<HealthCheckResult> {
  try {
    const res = await fetch("https://api.xero.com/timezones", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403) {
      return { status: "healthy", metric: `${res.status} (auth required)`, last_checked: new Date().toISOString() };
    }
    if (res.ok) return { status: "healthy", metric: `${res.status}`, last_checked: new Date().toISOString() };
    return { status: "warning", metric: `${res.status}`, last_checked: new Date().toISOString() };
  } catch {
    return { status: "pending", metric: null, last_checked: new Date().toISOString() };
  }
}

/* ── Helpers ───────────────────────────────────────────────────── */

export function parseCheck<T extends PromiseSettledResult<any>>(result: T): HealthCheckResult {
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

export function determineGlobal(systems: Array<{ status: string }>): HealthStatus {
  const hasCritical = systems.some((s) => s.status === "critical");
  if (hasCritical) return "critical";
  const hasWarning = systems.some((s) => s.status === "warning");
  if (hasWarning) return "warning";
  const allPending = systems.every((s) => s.status === "pending");
  if (allPending) return "pending";
  return "healthy";
}
