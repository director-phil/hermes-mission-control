/**
 * Probe runners — one per ProbeKind. Each returns the fields of a probe result
 * (status, latency, http_status, metric, error) without the id/ts/probe_id.
 */

import { readFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { resolve as dnsResolve } from "node:dns/promises";
import { InsertResultInput } from "./store";
import { ProbeDefinition, ProbeStatus } from "./types";

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
