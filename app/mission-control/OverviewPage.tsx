"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface Evidence {
  source: string;
  timestamp: string | null;
  status?: string;
  note?: string;
}

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
  evidence: Evidence;
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
  sources: Evidence[];
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
  work: { timestamp: string; goals: GoalRecord[]; summary: { total: number; running: number; ready: number; terminal: number; unknown: number } };
  trace: { timestamp: string; events: RuntimeEvent[]; warnings: Array<{ source: string; message: string }>; summary: { events: number; warnings: number; latest: string | null } };
  alerts: { alerts: RuntimeAlert[]; summary: { total: number; critical: number; warning: number; info: number } };
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
        const response = await fetch("/api/mission-control/runtime", { cache: "no-store" });
        if (!response.ok) throw new Error(`Runtime API ${response.status}`);
        const overview = await fetch("/api/mission-control/overview", { cache: "no-store" });
        if (!overview.ok) throw new Error(`Overview API ${overview.status}`);
        const nextData = await overview.json() as OverviewData;
        if (!cancelled) {
          setData(nextData);
          setSelectedGoalId((current) => current ?? nextData.work.goals[0]?.goal_id ?? null);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load runtime APIs");
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
    return <Shell><div className="rounded border border-red-800 bg-red-950/30 p-4 text-sm text-red-200">{error}</div></Shell>;
  }
  if (!data) {
    return <Shell><div className="text-sm font-mono text-slate-500">Loading runtime evidence...</div></Shell>;
  }

  return (
    <Shell timestamp={data.timestamp} severity={data.alerts.summary.critical > 0 ? "critical" : data.alerts.summary.warning > 0 ? "warning" : "observed"}>
      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel title="FLEET" meta={`${data.fleet.summary.processes} proc / ${data.fleet.summary.services} svc`} tone={data.fleet.summary.orphaned > 0 ? "critical" : "observed"}>
          <MetricRow label="controllers" value={data.fleet.summary.controllers} />
          <MetricRow label="wrappers" value={data.fleet.summary.wrappers} />
          <MetricRow label="orphaned" value={data.fleet.summary.orphaned} tone={data.fleet.summary.orphaned > 0 ? "critical" : "muted"} />
          <div className="mt-3 space-y-2">
            {data.fleet.processes.filter((process) => process.role !== "unrelated").slice(0, 8).map((process) => (
              <div key={process.pid} className="border-t border-slate-800 pt-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-100">{process.name} <span className="font-mono text-xs text-slate-500">pid {process.pid}</span></div>
                    <div className="min-w-0 break-words font-mono text-[11px] text-slate-500">{process.command_identity}</div>
                  </div>
                  <Status label={process.orphan ? "orphan" : process.role} tone={process.orphan ? "critical" : "observed"} />
                </div>
                <EvidenceLink evidence={process.evidence} />
              </div>
            ))}
            {data.fleet.processes.filter((process) => process.role !== "unrelated").length === 0 && <Empty text="No owned runtime processes found" />}
          </div>
        </Panel>

        <Panel title="WORK" meta={`${data.work.summary.total} goals`} tone={data.work.summary.unknown > 0 ? "warning" : "observed"}>
          <div className="grid grid-cols-4 gap-2">
            <MetricTile label="running" value={data.work.summary.running} />
            <MetricTile label="ready" value={data.work.summary.ready} />
            <MetricTile label="terminal" value={data.work.summary.terminal} />
            <MetricTile label="unknown" value={data.work.summary.unknown} />
          </div>
          <div className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="max-h-[520px] overflow-auto pr-1">
              {data.work.goals.map((goal) => (
                <button
                  key={goal.goal_id}
                  type="button"
                  onClick={() => setSelectedGoalId(goal.goal_id)}
                  className={`mb-2 block min-w-0 w-full border p-2 text-left ${selectedGoal?.goal_id === goal.goal_id ? "border-cyan-500 bg-cyan-950/20" : "border-slate-800 bg-slate-950/50 hover:border-slate-700"}`}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm text-slate-100">{goal.title ?? goal.goal_id}</span>
                    <Status label={goal.status} tone={goal.status === "failed" ? "critical" : goal.status === "unknown" ? "warning" : "observed"} />
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{goal.goal_id}</div>
                  <div className="mt-1 text-[11px] text-slate-400">stage {goal.stage ?? "unknown"} / queue {goal.queue_state}</div>
                </button>
              ))}
              {data.work.goals.length === 0 && <Empty text="No goal state files found" />}
            </div>
            <GoalDetail goal={selectedGoal} events={selectedEvents} />
          </div>
        </Panel>

        <Panel title="TRACE" meta={`${data.trace.summary.events} events`} tone={data.alerts.summary.critical > 0 ? "critical" : data.alerts.summary.warning > 0 ? "warning" : "observed"}>
          <div className="space-y-2">
            {data.alerts.alerts.slice(0, 6).map((alert) => (
              <div key={alert.id} className="border border-slate-800 bg-slate-950/50 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-slate-100">{alert.title}</div>
                  <Status label={alert.severity} tone={alert.severity === "critical" ? "critical" : "warning"} />
                </div>
                <p className="mt-1 min-w-0 break-words text-xs text-slate-400">{alert.message}</p>
                <div className="mt-2 min-w-0 break-words font-mono text-[11px] text-slate-500">{alert.action}</div>
                <EvidenceLink evidence={{ source: alert.evidence, timestamp: alert.source_timestamp }} />
              </div>
            ))}
            {data.alerts.alerts.length === 0 && <Empty text="No source-backed alerts" />}
          </div>
          <div className="mt-4 border-t border-slate-800 pt-3">
            {data.trace.events.slice(-10).reverse().map((event) => (
              <div key={event.id} className="mb-2 grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2 text-xs">
                <span className="font-mono text-slate-500">{formatTime(event.timestamp)}</span>
                <div className="min-w-0">
                  <div className="truncate text-slate-200">{event.type}</div>
                  <div className="truncate text-slate-500">{event.summary}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </Shell>
  );
}

function Shell({ children, timestamp, severity = "observed" }: { children: React.ReactNode; timestamp?: string; severity?: string }) {
  return (
    <main className="min-h-screen bg-[#070b10] px-3 py-3 text-slate-200 sm:px-5">
      <header className="mb-3 flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-wide text-white sm:text-lg">Hermes Mission Control</h1>
          <p className="font-mono text-[11px] text-slate-500">read-only local runtime observability</p>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
          <Status label={severity} tone={severity === "critical" ? "critical" : severity === "warning" ? "warning" : "observed"} />
          <span>{timestamp ? formatTime(timestamp) : "unknown timestamp"}</span>
        </div>
      </header>
      {children}
    </main>
  );
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

function GoalDetail({ goal, events }: { goal: GoalRecord | null; events: RuntimeEvent[] }) {
  if (!goal) return <Empty text="Select a goal for evidence" />;
  return (
    <div className="border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">{goal.title ?? goal.goal_id}</h3>
          <p className="truncate font-mono text-[11px] text-slate-500">{goal.goal_id}</p>
        </div>
        <Status label={goal.status} tone={goal.status === "failed" ? "critical" : goal.status === "unknown" ? "warning" : "observed"} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Fact label="controller" value={goal.controller_pid ? String(goal.controller_pid) : "unknown"} />
        <Fact label="stage" value={goal.stage ?? "unknown"} />
        <Fact label="queue" value={goal.queue_state} />
        <Fact label="last event" value={goal.last_event_timestamp ? formatTime(goal.last_event_timestamp) : "unknown"} />
      </div>
      {goal.worktree && (
        <div className="mt-3 border-t border-slate-800 pt-2">
          <div className="min-w-0 break-words text-xs text-slate-300">{goal.worktree.branch ?? "unknown branch"} / {goal.worktree.head?.slice(0, 10) ?? "unknown HEAD"}</div>
          <div className="font-mono text-[11px] text-slate-500">{goal.worktree.dirty === null ? "dirty unknown" : goal.worktree.dirty ? "dirty" : "clean"}</div>
          <EvidenceLink evidence={{ source: goal.worktree.source, timestamp: goal.worktree.timestamp }} />
        </div>
      )}
      <div className="mt-3 border-t border-slate-800 pt-2">
        {events.map((event) => (
          <div key={event.id} className="mb-2 text-xs">
            <div className="flex min-w-0 flex-wrap justify-between gap-2">
              <span className="min-w-0 break-words text-slate-200">{event.type}</span>
              <span className="font-mono text-slate-500">{formatTime(event.timestamp)}</span>
            </div>
            <div className="min-w-0 break-words text-slate-500">{event.summary}</div>
          </div>
        ))}
        {events.length === 0 && <Empty text="No run JSONL events for this goal" />}
      </div>
      <div className="mt-3 space-y-1 border-t border-slate-800 pt-2">
        {goal.sources.map((source) => <EvidenceLink key={`${source.source}:${source.note ?? ""}`} evidence={source} />)}
      </div>
    </div>
  );
}

function MetricRow({ label, value, tone = "observed" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-900 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={tone === "critical" ? "font-mono text-red-300" : tone === "muted" ? "font-mono text-slate-500" : "font-mono text-slate-100"}>{value}</span>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-slate-800 bg-slate-950/40 p-2">
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

function EvidenceLink({ evidence }: { evidence: Evidence }) {
  return (
    <div className="mt-1 min-w-0 break-words font-mono text-[11px] text-slate-600">
      <span className="break-all">{evidence.source}</span>
      <span className="ml-2 text-slate-700">{evidence.timestamp ? formatTime(evidence.timestamp) : "unknown time"}</span>
      {evidence.note && <span className="ml-2 break-words text-amber-400">{evidence.note}</span>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="border border-dashed border-slate-800 p-3 text-center text-xs text-slate-600">{text}</div>;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" });
}
