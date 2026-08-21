import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 5;

type Status = "healthy" | "warning" | "critical" | "pending";
type SystemResult = { name: string; status: Status; metric: string | null; last_checked: string };

const CHECK_TIMEOUT_MS = 2_500;
const OVERALL_TIMEOUT_MS = 3_500;

export async function GET() {
  const timestamp = new Date().toISOString();
  const checks: Array<[string, Promise<SystemResult>]> = [
    ["GB10 #1", checkModelSeat("GB10 #1", "gb10-box-1")],
    ["GB10 #2", checkModelSeat("GB10 #2", "gb10-box-2")],
    ["Hermes admission", checkJsonEndpoint("Hermes admission", "http://127.0.0.1:19875/healthz")],
    ["Qdrant", checkJsonEndpoint("Qdrant", "http://127.0.0.1:6333/collections")],
    ["Goal Conveyor", checkGoalConveyor()],
    ["Vercel", checkReachability("Vercel", "https://vercel.com/docs/rest-api", "HEAD")],
    ["GitHub", checkGitHub()],
    ["ServiceTitan", checkReachability("ServiceTitan", "https://auth.servicetitan.com/oauth2/token", "HEAD")],
    ["Xero", checkReachability("Xero", "https://api.xero.com/timezones", "GET")],
  ];

  const systems = await Promise.all(checks.map(([name, check]) => bounded(check, name)));
  const globalStatus = determineGlobal(systems);
  return NextResponse.json({
    timestamp,
    global_status: globalStatus,
    systems,
    total: systems.length,
    healthy: systems.filter((system) => system.status === "healthy").length,
    warning: systems.filter((system) => system.status === "warning").length,
    critical: systems.filter((system) => system.status === "critical").length,
    pending: systems.filter((system) => system.status === "pending").length,
  });
}

async function checkModelSeat(name: string, host: string): Promise<SystemResult> {
  try {
    const response = await fetch(`http://${host}:1234/v1/models`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) return result(name, "warning", `HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return result(name, "healthy", `${body.data?.length ?? 0} model IDs observed`);
  } catch {
    return result(name, "pending", "model endpoint unreachable");
  }
}

async function checkJsonEndpoint(name: string, url: string): Promise<SystemResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) return result(name, "warning", `HTTP ${response.status}`);
    await response.json();
    return result(name, "healthy", `HTTP ${response.status}`);
  } catch {
    return result(name, "pending", "endpoint unreachable");
  }
}

async function checkGoalConveyor(): Promise<SystemResult> {
  const source = "/home/phillip_downs/ChatDev/goals/state/queue-runner-status.json";
  try {
    const body = JSON.parse(await readFile(source, "utf8")) as {
      conveyor_on?: boolean;
      active?: unknown[];
      counts?: Record<string, number>;
    };
    const blocked = ["held", "blocked", "hard_stop", "invalid"]
      .reduce((sum, key) => sum + (Number(body.counts?.[key]) || 0), 0);
    const active = Array.isArray(body.active) ? body.active.length : 0;
    return result("Goal Conveyor", body.conveyor_on ? "healthy" : "warning", `${active} active; ${blocked} held/blocked`);
  } catch {
    return result("Goal Conveyor", "pending", "queue status unreadable");
  }
}

async function checkReachability(name: string, url: string, method: "GET" | "HEAD"): Promise<SystemResult> {
  try {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const reachable = response.status > 0 && response.status < 500;
    return result(name, "pending", reachable ? `HTTP ${response.status}; integration unverified` : `HTTP ${response.status}`);
  } catch {
    return result(name, "pending", "endpoint unreachable; integration unverified");
  }
}

async function checkGitHub(): Promise<SystemResult> {
  try {
    const response = await fetch("https://www.githubstatus.com/api/v2/status.json", { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) return result("GitHub", "pending", `HTTP ${response.status}`);
    const body = await response.json() as { status?: { indicator?: string; description?: string } };
    const indicator = body.status?.indicator ?? "unknown";
    return result("GitHub", indicator === "none" ? "healthy" : "warning", body.status?.description ?? indicator);
  } catch {
    return result("GitHub", "pending", "status endpoint unreachable");
  }
}

async function bounded(check: Promise<SystemResult>, name: string): Promise<SystemResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check,
      new Promise<SystemResult>((resolve) => {
        timer = setTimeout(() => resolve(result(name, "pending", "check timed out")), OVERALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function result(name: string, status: Status, metric: string | null): SystemResult {
  return { name, status, metric, last_checked: new Date().toISOString() };
}

function determineGlobal(systems: SystemResult[]): Status {
  if (systems.some((system) => system.status === "critical")) return "critical";
  if (systems.some((system) => system.status === "warning" || system.status === "pending")) return "warning";
  return "healthy";
}
