/**
 * S1 — Overview Page (First View Operating Shell)
 *
 * Displays all 8 operational signals in the first viewport.
 * Dark ops-centre theme. No generic KPI cards — operations centre layout.
 */

"use client";

import { useEffect, useState } from "react";

interface OverviewData {
  timestamp: string;
  system_health: SystemHealthSection;
  agent_capacity: AgentCapacitySection;
  approvals_required: ApprovalsSection;
  production_trust: ProductionTrustSection;
  live_agent_ops: LiveAgentOpsSection;
  active_tasks: ActiveTasksSection;
  event_stream: EventStreamSection;
  research_intelligence: ResearchSection;
}

interface SystemHealthSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  systems: Array<{
    name: string;
    status: string;
    metric: unknown;
    last_checked: string | null;
  }>;
}

interface AgentCapacitySection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  active_sessions: number;
  breakdown: Record<string, number>;
}

interface ApprovalsSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  count: number;
  items: unknown[];
}

interface ProductionTrustSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  trust_score: number | null;
  freshness: Array<{
    source: string;
    last_refresh: string;
    age_minutes: number;
    status: string;
  }>;
  integrity: { score: number | null; mismatches: number; last_recon: string | null };
  deployments: { railway: unknown; vercel: unknown };
}

interface LiveAgentOpsSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  agents: unknown[];
}

interface ActiveTasksSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  count: number;
  items: Array<{
    id: string;
    title: string;
    status: string;
    owner: string;
    updated_at: string;
  }>;
}

interface EventStreamSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  events: unknown[];
}

interface ResearchSection {
  status: string;
  label: string;
  evidence_timestamp: string | null;
  findings: unknown[];
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mission-control/overview")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message ?? "Failed to fetch overview");
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-500 text-sm font-mono">Initializing Mission Control…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-12 h-12 bg-red-950/50 border border-red-800/40 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-red-400 text-xl">⚠</span>
          </div>
          <p className="text-red-400 font-mono text-sm">{error ?? "Failed to load overview"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800/40">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-wide text-white">
              MISSION CONTROL
            </h1>
            <p className="text-xs text-slate-500 font-mono mt-0.5">
              Last updated: {new Date(data.timestamp).toLocaleTimeString()} AEST
            </p>
          </div>
          {/* 5-second questions */}
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${globalStatus(data) === "critical" ? "bg-red-500 animate-pulse" : globalStatus(data) === "warning" ? "bg-amber-500" : "bg-emerald-500"}`} />
              {globalStatus(data).toUpperCase()}
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400">
              {data.active_tasks.count} active
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400">
              {data.approvals_required.count} pending
            </span>
          </div>
        </div>
      </div>

      {/* 8-section grid */}
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">

        {/* 1. System Health */}
        <Section
          title="SYSTEM HEALTH"
          status={healthStripStatus(data.system_health)}
          pending={data.system_health.status === "pending"}
          pendingLabel={data.system_health.label}
        >
          {data.system_health.status === "pending"
            ? <PlaceholderRow label="Awaiting S2 live wiring" />
            : data.system_health.systems.map((s) => (
                <div key={s.name} className="flex items-center justify-between py-1">
                  <span className="text-xs text-slate-400">{s.name}</span>
                  <span className={`text-xs font-mono ${statusColor(s.status)}`}>
                    {s.status}
                  </span>
                </div>
              ))}
        </Section>

        {/* 2. Agent Capacity */}
        <Section
          title="AGENT CAPACITY"
          status={data.agent_capacity.active_sessions > 0 ? "info" : "neutral"}
          pending={data.agent_capacity.status === "pending"}
          pendingLabel={data.agent_capacity.label}
        >
          {data.agent_capacity.status === "pending"
            ? <PlaceholderRow label="Awaiting S3 live wiring" />
            : (<>
                <div className="py-2">
                  <span className="text-2xl font-bold text-white font-mono">
                    {data.agent_capacity.active_sessions}
                  </span>
                  <span className="text-xs text-slate-500 ml-1">active</span>
                </div>
                <div className="grid grid-cols-2 gap-1 text-xs font-mono">
                  {Object.entries(data.agent_capacity.breakdown).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-slate-500">{k}</span>
                      <span className="text-slate-300">{v}</span>
                    </div>
                  ))}
                </div>
              </>)
          }
        </Section>

        {/* 3. Approvals Required */}
        <Section
          title="APPROVALS REQUIRED"
          status={data.approvals_required.count > 0 ? "warning" : "neutral"}
          pending={data.approvals_required.status === "pending"}
          pendingLabel={data.approvals_required.label}
        >
          {data.approvals_required.status === "pending"
            ? <PlaceholderRow label="Awaiting S4 live wiring" />
            : data.approvals_required.count === 0
              ? <div className="py-2 text-xs text-emerald-400 font-mono">✓ No pending approvals</div>
              : (data.approvals_required.items as Array<{ title: string; evidence?: string; recommendation?: string }>).map((item, i) => (
                  <div key={i} className="py-1 border-b border-slate-800/30 last:border-0">
                    <div className="text-xs text-amber-300 font-medium">{item.title}</div>
                    {item.evidence && (
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">{item.evidence}</div>
                    )}
                  </div>
                ))}
        </Section>

        {/* 4. Production Trust */}
        <Section
          title="PRODUCTION TRUST"
          status={data.production_trust.trust_score !== null
            ? data.production_trust.trust_score >= 80 ? "info"
              : data.production_trust.trust_score >= 50 ? "warning" : "critical"
            : "neutral"}
          pending={data.production_trust.status === "pending"}
          pendingLabel={data.production_trust.label}
        >
          {data.production_trust.status === "pending"
            ? <PlaceholderRow label="Awaiting S6 live wiring" />
            : (<>
                <div className="py-2">
                  {data.production_trust.trust_score !== null ? (
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-bold text-white font-mono">
                        {data.production_trust.trust_score}%
                      </span>
                      <span className="text-xs text-slate-500">trust score</span>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500 font-mono">Score not yet computed</div>
                  )}
                </div>
                {data.production_trust.freshness.length > 0 && (
                  <div className="space-y-1">
                    {data.production_trust.freshness.slice(0, 3).map((f) => (
                      <div key={f.source} className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">{f.source}</span>
                        <span className={`font-mono ${f.status === "fresh" ? "text-emerald-400" : "text-amber-400"}`}>
                          {f.age_minutes < 0 ? "—" : `${f.age_minutes}m`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>)
          }
        </Section>

        {/* 5. Live Agent Operations */}
        <Section
          title="LIVE AGENT OPS"
          status={data.live_agent_ops.status === "pending" ? "neutral" : "info"}
          pending={data.live_agent_ops.status === "pending"}
          pendingLabel={data.live_agent_ops.label}
        >
          {data.live_agent_ops.status === "pending"
            ? <PlaceholderRow label="Awaiting S3 live wiring" />
            : data.live_agent_ops.agents.length === 0
              ? <div className="py-2 text-xs text-slate-500 font-mono">No active agents</div>
              : (data.live_agent_ops.agents as Array<{ name: string; task: string; status: string }>).slice(0, 5).map((a, i) => (
                  <div key={i} className="flex items-center justify-between py-1 text-xs">
                    <span className="text-slate-300">{a.name}</span>
                    <span className={`font-mono text-[10px] ${statusColor(a.status)}`}>{a.status}</span>
                  </div>
                ))}
        </Section>

        {/* 6. Active Tasks */}
        <Section
          title="ACTIVE TASKS"
          status={data.active_tasks.count > 0 ? "info" : "neutral"}
          pending={data.active_tasks.status === "pending"}
          pendingLabel={data.active_tasks.label}
        >
          {data.active_tasks.status === "pending"
            ? <PlaceholderRow label="Awaiting S5 live wiring" />
            : data.active_tasks.count === 0
              ? <div className="py-2 text-xs text-emerald-400 font-mono">✓ No active tasks</div>
              : (data.active_tasks.items).slice(0, 5).map((t) => (
                  <div key={t.id} className="py-1 border-b border-slate-800/30 last:border-0">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300 truncate max-w-[140px]" title={t.title}>{t.title}</span>
                      <span className={`font-mono text-[10px] ml-2 ${statusColor(t.status)}`}>{t.status}</span>
                    </div>
                    <div className="text-[10px] text-slate-600 font-mono mt-0.5">
                      {t.owner} · {timeAgo(t.updated_at)}
                    </div>
                  </div>
                ))}
        </Section>

        {/* 7. Event Stream */}
        <Section
          title="EVENT STREAM"
          status="neutral"
          pending={data.event_stream.status === "pending"}
          pendingLabel={data.event_stream.label}
        >
          {data.event_stream.status === "pending"
            ? <PlaceholderRow label="Awaiting S7 live wiring" />
            : data.event_stream.events.length === 0
              ? <div className="py-2 text-xs text-slate-500 font-mono">No events</div>
              : (data.event_stream.events as Array<{ type: string; message: string; timestamp: string }>).slice(0, 5).map((e, i) => (
                  <div key={i} className="py-1 border-b border-slate-800/30 last:border-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-mono text-[10px] px-1 rounded ${eventBadgeColor(e.type)}`}>
                        {e.type}
                      </span>
                      <span className="text-slate-400 truncate">{e.message}</span>
                    </div>
                    <div className="text-[10px] text-slate-600 font-mono mt-0.5">{timeAgo(e.timestamp)}</div>
                  </div>
                ))}
        </Section>

        {/* 8. Research Intelligence */}
        <Section
          title="RESEARCH INTELLIGENCE"
          status="neutral"
          pending={data.research_intelligence.status === "pending"}
          pendingLabel={data.research_intelligence.label}
        >
          {data.research_intelligence.status === "pending"
            ? <PlaceholderRow label="Awaiting S8 live wiring" />
            : data.research_intelligence.findings.length === 0
              ? <div className="py-2 text-xs text-slate-500 font-mono">No findings</div>
              : (data.research_intelligence.findings as Array<{ title: string; roi?: string; urgency?: string }>).slice(0, 5).map((f, i) => (
                  <div key={i} className="py-1 border-b border-slate-800/30 last:border-0">
                    <div className="text-xs text-slate-300">{f.title}</div>
                    <div className="flex gap-2 text-[10px] font-mono mt-0.5">
                      {f.roi && <span className="text-blue-400">ROI: {f.roi}</span>}
                      {f.urgency && <span className={`font-bold ${urgencyColor(f.urgency)}`}>{f.urgency}</span>}
                    </div>
                  </div>
                ))}
        </Section>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */

function Section({
  title,
  status,
  pending,
  pendingLabel,
  children,
}: {
  title: string;
  status: string;
  pending: boolean;
  pendingLabel: string;
  children: React.ReactNode;
}) {
  const borderColors: Record<string, string> = {
    neutral: "border-slate-800/30",
    info: "border-blue-800/30",
    warning: "border-amber-800/30",
    critical: "border-red-800/30",
  };

  const headerColors: Record<string, string> = {
    neutral: "text-slate-500",
    info: "text-blue-400",
    warning: "text-amber-400",
    critical: "text-red-400",
  };

  return (
    <div className={`bg-slate-900/50 border ${borderColors[status] || borderColors.neutral} rounded-lg overflow-hidden`}>
      <div className="px-3 py-2 border-b border-slate-800/20 flex items-center justify-between">
        <span className={`text-[10px] font-bold tracking-widest uppercase ${headerColors[status] || headerColors.neutral}`}>
          {title}
        </span>
        {pending && (
          <span className="text-[9px] text-slate-600 font-mono bg-slate-800/50 px-1.5 py-0.5 rounded">
            PENDING
          </span>
        )}
      </div>
      <div className="p-3">
        {pending ? (
          <div className="space-y-1">
            {children}
            <div className="text-[10px] text-slate-600 font-mono italic pt-1">
              {pendingLabel}
            </div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function PlaceholderRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-2">
      <div className="w-2 h-2 bg-amber-500/50 rounded-full animate-pulse" />
      <span className="text-[11px] text-slate-500 font-mono italic">{label}</span>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────── */

function globalStatus(data: OverviewData): string {
  const health = data.system_health;
  if (health.status === "pending") return "warning";

  const hasCritical = health.systems.some((s) => s.status === "critical");
  if (hasCritical) return "critical";

  const hasWarning = health.systems.some((s) => s.status === "warning");
  if (hasWarning) return "warning";

  return "info";
}

function healthStripStatus(health: SystemHealthSection): string {
  if (health.status === "pending") return "neutral";
  const hasCritical = health.systems.some((s) => s.status === "critical");
  if (hasCritical) return "critical";
  const hasWarning = health.systems.some((s) => s.status === "warning");
  if (hasWarning) return "warning";
  return "info";
}

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    healthy: "text-emerald-400",
    warning: "text-amber-400",
    critical: "text-red-400",
    running: "text-emerald-400",
    blocked: "text-red-400",
    completed: "text-slate-500",
    failed: "text-red-400",
    pending: "text-amber-400",
    neutral: "text-slate-400",
    info: "text-blue-400",
  };
  return colors[status] ?? "text-slate-400";
}

function eventBadgeColor(type: string): string {
  const colors: Record<string, string> = {
    deploy: "bg-blue-900/50 text-blue-400",
    health: "bg-emerald-900/50 text-emerald-400",
    approval: "bg-amber-900/50 text-amber-400",
    security: "bg-red-900/50 text-red-400",
    data: "bg-purple-900/50 text-purple-400",
    agent: "bg-cyan-900/50 text-cyan-400",
  };
  return colors[type] ?? "bg-slate-800/50 text-slate-400";
}

function urgencyColor(level: string): string {
  const colors: Record<string, string> = {
    high: "text-red-400",
    medium: "text-amber-400",
    low: "text-emerald-400",
  };
  return colors[level] ?? "text-slate-400";
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
