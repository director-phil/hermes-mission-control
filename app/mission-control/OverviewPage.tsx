"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  getMissionControlRoute,
  missionControlRoutes,
} from "./navigation";

// Types matching the bounded API responses
interface ProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  argv_redacted: string[];
  command_identity: string;
  role: string;
  rss_bytes: number | null;
  owner_goal_id: string | null;
  service_unit: string | null;
  orphan: boolean;
  evidence: { source: string; timestamp: string | null };
}

interface GoalRecord {
  goal_id: string;
  title: string | null;
  status: string;
  queue_state: string;
  stage: string | null;
  controller_pid: number | null;
  last_event_timestamp: string | null;
  stall_age_ms: number | null;
  blocker_ids: string[];
  dependency_ids: string[];
  worktree: { path: string; branch: string | null; head: string | null; dirty: boolean | null; source: string; timestamp: string | null } | null;
  sources: Array<{ source: string; timestamp: string | null }>;
}

interface RuntimeEvent {
  id: string;
  goal_id: string;
  type: string;
  timestamp: string;
  summary: string;
  source: string;
  source_timestamp: string | null;
  severity: string;
}

interface RuntimeAlert {
  id: string;
  goal_id: string | null;
  severity: string;
  title: string;
  message: string;
  evidence: string;
  source_timestamp: string | null;
  action: string;
}

interface OverviewData {
  timestamp: string;
  fleet: {
    timestamp: string;
    processes: ProcessRecord[];
    services: Array<{ unit: string; active_state: string; sub_state: string; main_pid: number | null; source: string; timestamp: string | null }>;
    worktrees: Array<{ path: string; branch: string | null; head: string | null; dirty: boolean | null; source: string; timestamp: string | null }>;
    source_warnings: Array<{ source: string; message: string }>;
    summary: { processes: number; controllers: number; wrappers: number; orphaned: number; services: number };
  };
  work: {
    timestamp: string;
    goals: GoalRecord[];
    summary: { total: number; staged: number; running: number; ready: number; pending_surface_verification: number; terminal: number; unknown: number; conflicted: number };
  };
  trace: {
    timestamp: string;
    events: RuntimeEvent[];
    warnings: Array<{ source: string; message: string }>;
    summary: { events: number; warnings: number; latest: string | null };
  };
  alerts: {
    alerts: RuntimeAlert[];
    summary: { total: number; critical: number; warning: number; info: number };
  };
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const overviewResponse = await fetch("/api/mission-control/overview", { cache: "no-store" });
        if (!overviewResponse.ok) throw new Error(`Overview API ${overviewResponse.status}`);
        const nextData = await overviewResponse.json() as OverviewData;

        if (!cancelled) {
          setData(nextData);
          setSelectedGoalId((current) => current ?? nextData.work.goals[0]?.goal_id ?? null);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load overview");
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

  const selectedGoal = useMemo(
    () => data?.work.goals.find((goal) => goal.goal_id === selectedGoalId) ?? data?.work.goals[0] ?? null,
    [data, selectedGoalId],
  );

  const selectedEvents = useMemo(
    () => data?.trace.events.filter((event) => selectedGoal && event.goal_id === selectedGoal.goal_id).slice(-12).reverse() ?? [],
    [data, selectedGoal],
  );

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  if (!data) {
    return <LoadingState />;
  }

  const { fleet, work, trace, alerts } = data;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
      {/* Fleet Panel */}
      <Panel title="FLEET" meta={`${fleet.summary.processes} proc / ${fleet.summary.services} svc`} tone={fleet.summary.orphaned > 0 ? "critical" : "observed"}>
        <MetricRow label="controllers" value={fleet.summary.controllers} />
        <MetricRow label="wrappers" value={fleet.summary.wrappers} />
        <MetricRow label="orphaned" value={fleet.summary.orphaned} tone={fleet.summary.orphaned > 0 ? "critical" : "muted"} />

        <div className="mt-4 space-y-2">
          {data.fleet.processes.filter((process) => process.role !== "unrelated").slice(0, 8).map((process) => (
            <div key={process.pid} className="border border-slate-700/50 bg-slate-900/30 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-100">{process.name} <span className="font-mono text-xs text-slate-500">pid {process.pid}</span></div>
                  <div className="min-w-0 break-words font-mono text-[11px] text-slate-500">{process.command_identity}</div>
                </div>
                <Status label={process.orphan ? "orphan" : process.role} tone={process.orphan ? "critical" : "observed"} />
              </div>
              {process.evidence.source && (
                <div className="mt-1 min-w-0 break-words font-mono text-[10px] text-slate-600">
                  source: {process.evidence.source}
                  {process.evidence.timestamp && ` • ${formatTime(process.evidence.timestamp)}`}
                </div>
              )}
            </div>
          ))}
          {data.fleet.processes.filter((process) => process.role !== "unrelated").length === 0 && <Empty text="No owned runtime processes found" />}
        </div>
      </Panel>

      {/* Work Panel */}
      <Panel title="WORK" meta={`${work.summary.total} goals`} tone={work.summary.conflicted > 0 ? "critical" : work.summary.unknown > 0 ? "warning" : "observed"}>
        <div className="grid grid-cols-7 gap-2">
          <MetricTile label="staged" value={work.summary.staged} />
          <MetricTile label="running" value={work.summary.running} />
          <MetricTile label="ready" value={work.summary.ready} />
          <MetricTile label="surface" value={work.summary.pending_surface_verification} />
          <MetricTile label="terminal" value={work.summary.terminal} />
          <MetricTile label="unknown" value={work.summary.unknown} />
          <MetricTile label="conflict" value={work.summary.conflicted} />
        </div>

        <div className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="max-h-[520px] overflow-auto pr-1">
            {work.goals.map((goal) => (
              <button
                key={goal.goal_id}
                type="button"
                onClick={() => setSelectedGoalId(goal.goal_id)}
                className={`mb-2 block min-w-0 w-full border p-2 text-left ${selectedGoal?.goal_id === goal.goal_id ? "border-cyan-500 bg-cyan-950/20" : "border-slate-700 bg-slate-900/30 hover:border-slate-600"}`}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-slate-100">{goal.title ?? goal.goal_id}</span>
                  <Status label={goal.status} tone={goal.status === "failed" || goal.status === "conflicted" ? "critical" : goal.status === "unknown" ? "warning" : "observed"} />
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{goal.goal_id}</div>
                {goal.stage && (
                  <div className="mt-1 text-[10px] text-slate-400">stage: {goal.stage} / queue: {goal.queue_state}</div>
                )}
              </button>
            ))}
            {work.goals.length === 0 && <Empty text="No goal state files found" />}
          </div>

          <GoalDetail goal={selectedGoal} events={selectedEvents} />
        </div>
      </Panel>

      {/* Trace Panel */}
      <Panel title="TRACE" meta={`${trace.summary.events} events`} tone={alerts.summary.critical > 0 ? "critical" : alerts.summary.warning > 0 ? "warning" : "observed"}>
        <div className="space-y-2">
          {alerts.alerts.slice(0, 6).map((alert) => (
            <div key={alert.id} className="border border-slate-700/50 bg-slate-900/30 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm text-slate-100">{alert.title}</div>
                <Status label={alert.severity} tone={alert.severity === "critical" ? "critical" : alert.severity === "warning" ? "warning" : "observed"} />
              </div>
              {alert.message && (
                <p className="mt-1 min-w-0 break-words text-xs text-slate-400">{alert.message}</p>
              )}
              {alert.action && (
                <div className="mt-2 min-w-0 break-words font-mono text-[11px] text-slate-500">action: {alert.action}</div>
              )}
            </div>
          ))}
          {alerts.alerts.length === 0 && <Empty text="No source-backed alerts" />}
        </div>

        <div className="mt-4 border-t border-slate-700 pt-3">
          {trace.events.slice(-10).reverse().map((event) => (
            <div key={event.id} className="mb-2 grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2 text-xs">
              <span className="font-mono text-slate-500">{formatTime(event.timestamp)}</span>
              <div className="min-w-0">
                <div className="truncate text-slate-200">{event.type}</div>
                {event.summary && <div className="truncate text-slate-500">{event.summary}</div>}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="mc-placeholder" aria-label="Error state">
      <p className="mc-placeholder-label">Overview</p>
      <h2>failed to load</h2>
      <p>{message}</p>
      <button onClick={onRetry} className="mc-retry-button mt-4 inline-flex items-center justify-center rounded border px-4 py-2 font-medium text-slate-100 hover:bg-slate-800">
        Retry
      </button>
    </section>
  );
}

function LoadingState() {
  return (
    <section className="mc-placeholder" aria-label="Loading state">
      <p className="mc-placeholder-label">Overview</p>
      <h2>loading runtime evidence…</h2>
      <p>This page shows system overview backed by bounded truthful data.</p>
    </section>
  );
}

function GoalDetail({ goal, events }: { goal: GoalRecord | null; events: RuntimeEvent[] }) {
  if (!goal) return <Empty text="Select a goal for evidence" />;

  return (
    <div className="border border-slate-700/50 bg-slate-900/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">{goal.title ?? goal.goal_id}</h3>
          {goal.goal_id && <p className="truncate font-mono text-[11px] text-slate-500">{goal.goal_id}</p>}
        </div>
        <Status label={goal.status} tone={goal.status === "failed" || goal.status === "conflicted" ? "critical" : goal.status === "unknown" ? "warning" : "observed"} />
      </div>

      {goal.stage && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <Fact label="controller" value={goal.controller_pid ? `pid:${goal.controller_pid}` : "unknown"} />
          <Fact label="stage" value={goal.stage} />
          <Fact label="queue" value={goal.queue_state} />
          <Fact label="last event" value={goal.last_event_timestamp ? formatTime(goal.last_event_timestamp) : "unknown"} />
        </div>
      )}

      {goal.worktree && (
        <div className="mt-3 border-t border-slate-700 pt-2">
          <div className="min-w-0 break-words text-xs text-slate-300">{goal.worktree.branch ?? "unknown branch"} / {goal.worktree.head?.slice(0, 10) ?? "unknown HEAD"}</div>
          <div className="font-mono text-[10px] text-slate-500">{goal.worktree.dirty === null ? "dirty unknown" : goal.worktree.dirty ? "dirty" : "clean"}</div>
        </div>
      )}

      {events.length > 0 && (
        <div className="mt-3 border-t border-slate-700 pt-2">
          <h4 className="mb-1 text-[10px] uppercase tracking-wide text-slate-600">recent events</h4>
          {events.map((event) => (
            <div key={event.id} className="mb-1 text-xs">
              <div className="flex min-w-0 flex-wrap justify-between gap-2">
                <span className="min-w-0 break-words text-slate-200">{event.type}</span>
                <span className="font-mono text-slate-500">{formatTime(event.timestamp)}</span>
              </div>
              {event.summary && <div className="min-w-0 break-words text-slate-500">{event.summary}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricRow({ label, value, tone = "observed" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-800 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={tone === "critical" ? "font-mono text-red-300" : tone === "muted" ? "font-mono text-slate-500" : "font-mono text-slate-100"}>{value}</span>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-slate-700/50 bg-slate-900/30 p-2">
      <div className="font-mono text-lg text-white">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-600">{label}</div>
      <div className="break-words font-mono text-slate-300">{value}</div>
    </div>
  );
}

function Status({ label, tone }: { label: string; tone: string }) {
  const color = tone === "critical" ? "border-red-800 text-red-300" : tone === "warning" ? "border-amber-800 text-amber-300" : "border-cyan-800 text-cyan-300";
  return <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase ${color}`}>{label}</span>;
}

function Empty({ text }: { text: string }) {
  return <div className="border border-dashed border-slate-700 p-3 text-center text-xs text-slate-600">{text}</div>;
}

function Panel({ title, meta, tone, children }: { title: string; meta: string; tone: string; children: React.ReactNode }) {
  return (
    <section className={`min-w-0 border bg-[#0b1118] ${tone === "critical" ? "border-red-900/70" : tone === "warning" ? "border-amber-900/70" : "border-slate-800"}`}>
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <h2 className="text-xs font-bold tracking-[0.18em] text-cyan-300">{title}</h2>
        <span className="font-mono text-[11px] text-slate-500">{meta}</span>
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </section>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" });
}
