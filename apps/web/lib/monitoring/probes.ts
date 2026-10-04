/**
 * Probe runners — one per ProbeKind. Each returns the fields of a probe result
 * (status, latency, http_status, metric, error) without the id/ts/probe_id.
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { resolve as dnsResolve } from "node:dns/promises";
import { InsertResultInput } from "./store";
import { ProbeDefinition, ProbeStatus } from "./types";

const VERCEL_PROJECT_ID = "prj_lACCcoDN44Doh8pC6X3XY7E3lm2w";
const VERCEL_TEAM_ID = "reliabletradies";

const DEFAULT_TIMEOUT_MS = 5000;

export type ProbeOutcome = InsertResultInput;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latency_ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latency_ms: Date.now() - start };
}

export async function runProbe(def: ProbeDefinition): Promise<ProbeOutcome> {
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    switch (def.kind) {
      case "http":
      case "loopback-http":
        return await httpProbe(def.target, timeoutMs);
      case "tcp":
        return await tcpProbe(def.target, timeoutMs);
      case "dns":
        return await dnsProbe(def.target, timeoutMs);
      case "ssl":
        return await sslProbe(def.target, timeoutMs);
      case "local-file":
        return await localFileProbe(def.target);
      case "server":
        return await serverProbe();
      case "page-sweep":
        return await pageSweepProbe(def, timeoutMs);
      case "vercel-deploy":
        return await vercelDeployProbe();
      default:
        return { status: "down", latency_ms: null, http_status: null, metric: null, error: `unknown kind ${def.kind}` };
    }
  } catch (err) {
    return { status: "down", latency_ms: null, http_status: null, metric: null, error: String(err) };
  }
}

async function httpProbe(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  const { value: res, latency_ms } = await timed(() =>
    fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  const status = res.status < 500 ? "up" : "down";
  return {
    status,
    latency_ms,
    http_status: res.status,
    metric: status === "up" ? `HTTP ${res.status}` : `HTTP ${res.status}`,
    error: status === "up" ? null : `HTTP ${res.status}`,
  };
}

function tcpProbe(target: string, timeoutMs: number): Promise<ProbeOutcome> {
  const [host, portStr] = target.split(":");
  const port = Number.parseInt(portStr, 10);
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: "connect timeout" });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      const latency_ms = Date.now() - start;
      socket.destroy();
      resolve({ status: "up", latency_ms, http_status: null, metric: `tcp ${host}:${port}`, error: null });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: String(err.message ?? err) });
    });
  });
}

async function dnsProbe(hostname: string, timeoutMs: number): Promise<ProbeOutcome> {
  const { value: addresses, latency_ms } = await timed(() =>
    Promise.race([
      dnsResolve(hostname, "A"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dns timeout")), timeoutMs)),
    ]),
  );
  return { status: "up", latency_ms, http_status: null, metric: addresses.join(", "), error: null };
}

function sslProbe(host: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = tlsConnect({
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: "tls timeout" });
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const latency_ms = Date.now() - start;
      const cert = socket.getPeerCertificate();
      socket.end();
      const validTo = cert?.valid_to;
      if (!validTo) {
        resolve({ status: "down", latency_ms, http_status: null, metric: null, error: "no cert valid_to" });
        return;
      }
      const daysLeft = Math.floor((new Date(validTo).getTime() - Date.now()) / 86400000);
      let status: ProbeStatus = "up";
      if (daysLeft <= 0) status = "down";
      else if (daysLeft <= 14) status = "degraded";
      resolve({
        status,
        latency_ms,
        http_status: null,
        metric: `${daysLeft}d left · ${cert.issuer?.O ?? "unknown issuer"}`,
        error: status === "down" ? "cert expired" : null,
      });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: String(err.message ?? err) });
    });
  });
}

async function localFileProbe(path: string): Promise<ProbeOutcome> {
  const start = Date.now();
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const latency_ms = Date.now() - start;
    if (typeof data.conveyor_on === "boolean") {
      return data.conveyor_on
        ? { status: "up", latency_ms, http_status: null, metric: "conveyor on", error: null }
        : { status: "degraded", latency_ms, http_status: null, metric: "conveyor off", error: "conveyor disabled" };
    }
    return { status: "up", latency_ms, http_status: null, metric: "readable", error: null };
  } catch (err) {
    return { status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: String(err) };
  }
}

/**
 * Page sweep probe — probes a list of relative paths under a base URL and
 * reports per-route status. Catches server/edge 5xx failures and slow public
 * responses (load issues) across the whole surface. Emits a JSON `metric` with
 * a per-route breakdown that the UI renders. Sweeps with bounded concurrency so
 * a large route set doesn't stall the engine loop.
 */
async function pageSweepProbe(def: ProbeDefinition, timeoutMs: number): Promise<ProbeOutcome> {
  const paths = def.targets ?? [];
  const base = def.target.replace(/\/+$/, "");
  const WARN_MS = 1000;
  const CONCURRENCY = 15;
  type RouteResult = { path: string; http: number | null; ms: number; status: ProbeStatus };
  const routes: (RouteResult | undefined)[] = new Array(paths.length);

  for (let start = 0; start < paths.length; start += CONCURRENCY) {
    const chunk = paths.slice(start, start + CONCURRENCY);
    await Promise.all(
      chunk.map(async (path, k) => {
        const idx = start + k;
        const url = base + (path.startsWith("/") ? path : `/${path}`);
        const t0 = Date.now();
        try {
          const res = await fetch(url, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
          const ms = Date.now() - t0;
          const status: ProbeStatus = res.status >= 500 ? "down" : ms > WARN_MS ? "degraded" : "up";
          routes[idx] = { path, http: res.status, ms, status };
        } catch {
          routes[idx] = { path, http: null, ms: Date.now() - t0, status: "down" };
        }
      }),
    );
  }

  const results = routes.filter((r): r is RouteResult => r !== undefined);
  const down = results.filter((r) => r.status === "down").length;
  const degraded = results.filter((r) => r.status === "degraded").length;
  const up = results.length - down - degraded;
  // Aggregate status reflects failures (5xx) only. Slow routes (degraded) are
  // informational and surfaced via the metric, not as an incident/health signal
  // — otherwise Vercel cold starts would keep the board in a permanent "warning"
  // and fire spurious Slack alerts.
  const overall: ProbeStatus = down > 0 ? "down" : "up";

  return {
    status: overall,
    latency_ms: null,
    http_status: null,
    metric: JSON.stringify({ total: results.length, up, degraded, down, routes: results }),
    error: overall === "down" ? `${down}/${results.length} route(s) down` : null,
  };
}

/**
 * Host metrics probe (CheckCle "server monitoring" equivalent) — reads the local
 * box's CPU load, RAM, disk and cumulative network counters. Emits a JSON `metric`
 * that the UI parses into a metrics panel.
 */
function serverProbe(): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    try {
      const load = os.loadavg(); // [1m, 5m, 15m]
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramPct = Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10;

      let diskPct: number | null = null;
      try {
        const out = execSync("df -P /", { encoding: "utf8" });
        const parts = out.trim().split("\n")[1]?.split(/\s+/);
        if (parts && parts.length >= 5) diskPct = Number.parseFloat(parts[4]);
      } catch {
        diskPct = null;
      }

      let netRx = 0;
      let netTx = 0;
      try {
        const net = readFileSync("/proc/net/dev", "utf8");
        for (const line of net.split("\n").slice(2)) {
          const m = line.trim().split(/\s+/);
          if (m.length < 10) continue;
          const iface = m[0].replace(":", "");
          if (iface === "lo" || iface.startsWith("br-") || iface.startsWith("docker") || iface.startsWith("veth")) continue;
          netRx += Number.parseInt(m[1], 10) || 0;
          netTx += Number.parseInt(m[9], 10) || 0;
        }
      } catch {
        /* ignore */
      }

      const metric = JSON.stringify({
        cpu_load1: load[0],
        cpu_load5: load[1],
        cpu_load15: load[2],
        ram_pct: ramPct,
        disk_pct: diskPct,
        net_rx_mb: Math.round(netRx / 1024 / 1024),
        net_tx_mb: Math.round(netTx / 1024 / 1024),
      });

      let status: ProbeStatus = "up";
      if (ramPct >= 95 || (diskPct != null && diskPct >= 90)) status = "degraded";

      resolve({ status, latency_ms: Date.now() - start, http_status: null, metric, error: null });
    } catch (err) {
      resolve({ status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: String(err) });
    }
  });
}

/**
 * Vercel deployment probe — reads the Vercel CLI token and queries the latest
 * deployment state for the RT V2 project, so the board shows whether the newest
 * deploy is READY / BUILDING / ERROR.
 */
async function vercelDeployProbe(): Promise<ProbeOutcome> {
  const start = Date.now();
  try {
    const authPath = join(homedir(), ".local", "share", "com.vercel.cli", "auth.json");
    const raw = await readFile(authPath, "utf8");
    const auth = JSON.parse(raw) as { token?: string };
    const token = auth.token;
    if (!token) throw new Error("no vercel token");

    const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&limit=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return { status: "down", latency_ms, http_status: res.status, metric: null, error: `vercel api ${res.status}` };
    }
    const json = (await res.json()) as { deployments?: Array<Record<string, unknown>> };
    const dep = json.deployments?.[0];
    if (!dep) {
      return { status: "down", latency_ms, http_status: res.status, metric: null, error: "no deployments" };
    }
    const state = String(dep.state ?? "UNKNOWN");
    const readyState = String(dep.readyState ?? "UNKNOWN");
    const meta = (dep.meta ?? {}) as Record<string, unknown>;
    const branch = String(meta.githubCommitRef ?? dep.target ?? "—");

    let status: ProbeStatus = "up";
    if (state === "ERROR" || readyState === "ERROR") status = "down";
    else if (state === "CANCELED") status = "degraded";

    return {
      status,
      latency_ms,
      http_status: res.status,
      metric: `deploy ${state} · ${branch}`,
      error: status === "down" ? `deploy ${state}` : null,
    };
  } catch (err) {
    return { status: "down", latency_ms: Date.now() - start, http_status: null, metric: null, error: String(err) };
  }
}
