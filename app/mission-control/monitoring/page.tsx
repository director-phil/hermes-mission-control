"use client";

import { useEffect, useRef, useState } from "react";

type ProbeStatus = "up" | "degraded" | "down";
type GlobalStatus = "healthy" | "warning" | "critical";

interface ProbeDefinition {
  id: string;
  name: string;
  kind: string;
  target: string;
  cadenceSeconds: number;
  group: "internal" | "external";
}

interface ProbeResult {
  ts: string;
  status: ProbeStatus;
  latency_ms: number | null;
  http_status: number | null;
  metric: string | null;
  error: string | null;
}

interface Incident {
  id: number;
  probe_id: string;
  probe_name: string;
  opened_ts: string;
  state: "open" | "resolved";
  last_status: ProbeStatus;
  last_error: string | null;
}

interface ServiceStatus {
  probe: ProbeDefinition;
  latest: ProbeResult | null;
  uptimePct24h: number | null;
  incident: Incident | null;
}

interface Snapshot {
  generated_ts: string;
  global_status: GlobalStatus;
  services: ServiceStatus[];
  open_incidents: Incident[];
  total: number;
  up: number;
  degraded: number;
  down: number;
}

export default function MonitoringPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch("/api/mission-control/monitoring", { cache: "no-store" });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const next = (await res.json()) as Snapshot;
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load");
      } finally {
        inFlight.current = false;
      }
    }
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (error) {
    return (
      <section className="mc-placeholder" aria-label="Monitoring error">
        <p className="mc-placeholder-label">Monitoring</p>
        <h2>failed to load</h2>
        <p>{error}</p>
        <button onClick={() => window.location.reload()} className="mc-retry-button mt-4 inline-flex items-center justify-center rounded border px-4 py-2 font-medium text-slate-100 hover:bg-slate-800">
          Retry
        </button>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="mc-placeholder" aria-label="Monitoring loading">
        <p className="mc-placeholder-label">Monitoring</p>
        <h2>loading service board…</h2>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {/* Freshness header + global rollup */}
      <section className={`min-w-0 border ${data.global_status === "critical" ? "border-red-900/70" : data.global_status === "warning" ? "border-amber-900/70" : "border-slate-800"} bg-[#0b1118]`}>
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <h2 className="text-xs font-bold tracking-[0.18em] text-cyan-300">SERVICE BOARD</h2>
          <span className="font-mono text-[11px] text-slate-500">last sweep {formatTime(data.generated_ts)}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
          <MetricTile label="total" value={data.total} />
          <MetricTile label="up" value={data.up} tone="up" />
          <MetricTile label="degraded" value={data.degraded} tone="degraded" />
          <MetricTile label="down" value={data.down} tone="down" />
        </div>
      </section>

      {/* Service grid */}
      <section className="min-w-0 border border-slate-800 bg-[#0b1118]">
        <div className="border-b border-slate-800 px-3 py-2">
          <h2 className="text-xs font-bold tracking-[0.18em] text-cyan-300">SERVICES</h2>
        </div>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">status</th>
                <th className="px-3 py-2">service</th>
                <th className="px-3 py-2">target</th>
                <th className="px-3 py-2">latency</th>
                <th className="px-3 py-2">uptime 24h</th>
                <th className="px-3 py-2">detail</th>
              </tr>
            </thead>
            <tbody>
              {data.services.map((service) => (
                <ServiceRow key={service.probe.id} service={service} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Open incidents */}
      <section className={`min-w-0 border ${data.open_incidents.length > 0 ? "border-red-900/70" : "border-slate-800"} bg-[#0b1118]`}>
        <div className="border-b border-slate-800 px-3 py-2">
          <h2 className="text-xs font-bold tracking-[0.18em] text-cyan-300">OPEN INCIDENTS ({data.open_incidents.length})</h2>
        </div>
        <div className="space-y-2 p-3">
          {data.open_incidents.length === 0 && <Empty text="No open incidents" />}
          {data.open_incidents.map((incident) => (
            <div key={incident.id} className="border border-red-900/50 bg-red-950/20 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm text-slate-100">{incident.probe_name}</div>
                <StatusDot status={incident.last_status} />
              </div>
              <div className="mt-1 font-mono text-[11px] text-slate-500">opened {formatTime(incident.opened_ts)}</div>
              {incident.last_error && <div className="mt-1 min-w-0 break-words font-mono text-[11px] text-red-300">{incident.last_error}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ServiceRow({ service }: { service: ServiceStatus }) {
  const { probe, latest } = service;
  const status = latest?.status ?? null;
  return (
    <tr className="border-b border-slate-800/60 hover:bg-slate-900/40">
      <td className="px-3 py-2">
        {status ? <StatusDot status={status} /> : <span className="font-mono text-[10px] text-slate-600">—</span>}
      </td>
      <td className="px-3 py-2">
        <div className="text-slate-100">{probe.name}</div>
        <div className="font-mono text-[10px] text-slate-500">
          {probe.group} · {probe.kind} · {probe.cadenceSeconds}s
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{probe.target}</td>
      <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{latest?.latency_ms != null ? `${latest.latency_ms}ms` : "—"}</td>
      <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{service.uptimePct24h != null ? `${service.uptimePct24h}%` : "—"}</td>
      <td className="px-3 py-2">
        <div className="font-mono text-[11px] text-slate-400">{latest?.metric ?? "—"}</div>
        {latest?.error && <div className="font-mono text-[11px] text-red-300">{latest.error}</div>}
      </td>
    </tr>
  );
}

function StatusDot({ status }: { status: ProbeStatus }) {
  const color = status === "up" ? "bg-emerald-400" : status === "degraded" ? "bg-amber-400" : "bg-red-500";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      <span className={`font-mono text-[10px] uppercase ${status === "up" ? "text-emerald-300" : status === "degraded" ? "text-amber-300" : "text-red-300"}`}>{status}</span>
    </span>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number; tone?: ProbeStatus | null }) {
  const color = tone === "up" ? "text-emerald-300" : tone === "degraded" ? "text-amber-300" : tone === "down" ? "text-red-300" : "text-white";
  return (
    <div className="border border-slate-700/50 bg-slate-900/30 p-2">
      <div className={`font-mono text-lg ${color}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="border border-dashed border-slate-700 p-3 text-center text-xs text-slate-600">{text}</div>;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" });
}
