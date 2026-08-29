"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Hermy HQ — Plugin / Component Stack Map
 *
 * A live "stack map" of the Hermes local-orchestration components, organized
 * into named layers, with a live status dot per component sourced from the
 * existing `/api/mission-control/system-health` + `/runtime` endpoints.
 */

type Status = "healthy" | "warning" | "critical" | "pending" | "unknown";

type Component = { name: string; healthKey?: string };

const LAYERS: { name: string; blurb: string; components: Component[] }[] = [
  {
    name: "Desktop plugins",
    blurb: "Hermes desktop app plugins that add UI panes and commands.",
    components: [
      { name: "hermes-achievements" },
      { name: "rt-extensions" },
      { name: "ai-document-extraction" },
    ],
  },
  {
    name: "Orchestration",
    blurb: "Goal conveyor and native runner that dispatch and ship work.",
    components: [
      { name: "goal-conveyor", healthKey: "conveyor" },
      { name: "native-goal-runner", healthKey: "native" },
    ],
  },
  {
    name: "Model gateway",
    blurb: "Admission gateway (:19875) and the logical model seats.",
    components: [
      { name: "admission-gateway", healthKey: "admission" },
      { name: "local-planner" },
      { name: "local-coder" },
      { name: "local-reviewer" },
      { name: "text-embedding-bge-m3" },
    ],
  },
  {
    name: "Physical boxes",
    blurb: "GB10 hardware and the local LM Studio servers.",
    components: [
      { name: "gb10-coder", healthKey: "GB10 #1" },
      { name: "gb10-reviewer", healthKey: "GB10 #2" },
    ],
  },
  {
    name: "Observability",
    blurb: "Telemetry and the mission-control API surface itself.",
    components: [
      { name: "langfuse", healthKey: "langfuse" },
      { name: "mission-control api", healthKey: "mission-control" },
    ],
  },
];

type HealthCheck = { name?: string; status?: Status; metric?: unknown; last_checked?: string | null };

const STATUS_DOT: Record<Status, string> = {
  healthy: "bg-emerald-400",
  warning: "bg-amber-400",
  critical: "bg-rose-500",
  pending: "bg-sky-400",
  unknown: "bg-slate-600",
};

const STATUS_LABEL: Record<Status, string> = {
  healthy: "ok",
  warning: "degraded",
  critical: "down",
  pending: "pending",
  unknown: "unknown",
};

export default function PluginsPage() {
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [globalStatus, setGlobalStatus] = useState<Status | null>(null);
  const [runtimeOk, setRuntimeOk] = useState<boolean | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [h, r] = await Promise.all([
          fetch("/api/mission-control/system-health").then((x) => x.json()),
          fetch("/api/mission-control/runtime").then((x) => x.json()),
        ]);
        if (cancelled) return;
        const checks = Array.isArray(h)
          ? h
          : Array.isArray(h?.systems)
            ? h.systems
            : Array.isArray(h?.checks)
              ? h.checks
              : [];
        setHealthChecks(checks);
        setGlobalStatus(typeof h?.global_status === "string" ? h.global_status : null);
        setRuntimeOk(!!r);
        setLastRefreshed(new Date());
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "fetch failed");
      }
    }
    poll();
    const timer = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const overall = useMemo(() => {
    if (globalStatus && globalStatus !== "unknown") return globalStatus;
    const statuses = healthChecks.map((c) => c.status).filter(Boolean) as Status[];
    if (statuses.includes("critical")) return "critical";
    if (statuses.includes("warning")) return "warning";
    if (statuses.length === 0) return "unknown";
    if (statuses.every((s) => s === "healthy")) return "healthy";
    if (statuses.some((s) => s === "pending")) return "pending";
    return "healthy";
  }, [healthChecks]);

  function statusFor(component: Component): Status {
    const needle = (component.healthKey ?? component.name).toLowerCase();
    const match = healthChecks.find((c) =>
      (c.name ?? "").toLowerCase().includes(needle),
    );
    if (match?.status) return match.status;
    if (component.name === "mission-control api" && runtimeOk !== null) {
      return runtimeOk ? "healthy" : "critical";
    }
    return "unknown";
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-8 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Plugin Stack</h1>
            <p className="mt-1 text-sm text-slate-400">
              Hermes local-orchestration components, layered top-to-bottom.
            </p>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[overall]}`} />
              <span className="text-slate-300 capitalize">{STATUS_LABEL[overall]}</span>
            </span>
            <span className="text-slate-500">
              {lastRefreshed
                ? `refreshed ${lastRefreshed.toLocaleTimeString()}`
                : "waiting for first poll"}
            </span>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-rose-400">poll error: {error}</p>}
      </header>

      <main className="space-y-6 px-8 py-8">
        {LAYERS.map((layer) => (
          <section key={layer.name}>
            <div className="mb-3">
              <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
                {layer.name}
              </h2>
              <p className="text-xs text-slate-500">{layer.blurb}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              {layer.components.map((component) => {
                const status = statusFor(component);
                return (
                  <div
                    key={component.name}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate font-mono text-sm text-slate-200">
                        {component.name}
                      </span>
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                        title={STATUS_LABEL[status]}
                      />
                    </div>
                    <p className="mt-1 text-xs capitalize text-slate-500">
                      {STATUS_LABEL[status]}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
