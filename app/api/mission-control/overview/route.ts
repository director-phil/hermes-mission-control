/**
 * S1+S3+S4 — Overview endpoint (operating shell)
 *
 * Aggregates all sections in parallel.
 * S2: system-health wired.
 * S3: agent-capacity wired.
 * S4: approvals wired.
 * Other slices use placeholder data.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date().toISOString();

  const systemHealthPromise = fetchSystemHealth().catch(err => {
    console.error('System health fetch failed:', err);
    return { error: 'Failed to fetch system health' };
  });

  const [systemHealth, agentCapacity, alertsData, approvalsRequired, productionTrust,
          liveAgentOps, activeTasks, eventStream, researchIntelligence] =
    await Promise.allSettled([
      systemHealthPromise,
      fetchAgentCapacity(),
      fetchAlerts(),
      fetchApprovalsRequired(),
      fetchProductionTrust(),
      fetchLiveAgentOps(),
      fetchActiveTasks(),
      fetchEventStream(),
      fetchResearchIntelligence(),
    ]);

  return Response.json({
    timestamp: now,
    system_health: parseResult(systemHealth),
    agent_capacity: parseResult(agentCapacity),
    alerts: parseResult(alertsData),
    approvals_required: parseResult(approvalsRequired),
    production_trust: parseResult(productionTrust),
    live_agent_ops: parseResult(liveAgentOps),
    active_tasks: parseResult(activeTasks),
    event_stream: parseResult(eventStream),
    research_intelligence: parseResult(researchIntelligence),
  });
}

/* - section fetchers - */

async function fetchSystemHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/system-health`, {
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return fetchLocalHealth();
  }
}

async function fetchLocalHealth() {
  const now = new Date().toISOString();
  const cpuLoad = await readCpuLoad();
  const memInfo = await readMemoryInfo();
  const diskInfo = await readDiskInfo("/");

  const status =
    cpuLoad.load > 90 || memInfo.percent > 95 || diskInfo.percent > 95
      ? "critical"
      : cpuLoad.load > 70 || memInfo.percent > 80 || diskInfo.percent > 80
        ? "warning"
        : "healthy";

  return {
    timestamp: now,
    global_status: status,
    systems: [
      { name: "GB10 #1", status, metric: `${cpuLoad.load}% CPU - ${memInfo.percent}% RAM - ${diskInfo.percent}% disk`, last_checked: now, evidence: "local" },
      { name: "GB10 #2", status: "unreachable", metric: "", last_checked: now, evidence: "no SSH config" },
      { name: "Hermes", status: "unreachable", metric: "", last_checked: now, evidence: "no process check" },
      { name: "Qdrant", status: "unreachable", metric: "", last_checked: now, evidence: "no QDRANT_URL" },
      { name: "Railway", status: "unreachable", metric: "", last_checked: now, evidence: "no RAILWAY_TOKEN" },
      { name: "Vercel", status: "unreachable", metric: "", last_checked: now, evidence: "no VERCEL_TOKEN" },
      { name: "GitHub", status: "unreachable", metric: "", last_checked: now, evidence: "no GITHUB_TOKEN" },
      { name: "ServiceTitan", status: "unreachable", metric: "", last_checked: now, evidence: "no credentials" },
      { name: "Xero", status: "unreachable", metric: "", last_checked: now, evidence: "no XERO_TENANT_ID" },
    ],
    total: 9,
    healthy: status === "healthy" ? 1 : 0,
    warning: status === "warning" ? 1 : 0,
    critical: status === "critical" ? 1 : 0,
    unreachable: 8,
  };
}

async function fetchAgentCapacity() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/agent-capacity`, {
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const activeSessions = data.active_agents ?? 0;
    const breakdown = data.breakdown ?? { online: 0, busy: 0, idle: 0, offline: 0 };

    return {
      status: data.global_status === "healthy" ? "info" : "warning",
      label: data.global_status === "healthy" ? "All agents operational" : "Some agents offline",
      evidence_timestamp: data.timestamp ?? null,
      active_sessions: activeSessions,
      agents: data.agents ?? [],
      platform_health: data.platform_health ?? [],
      sync_status: data.sync_status ?? { droplet: { reachable: false, evidence: "unreachable" }, msi: { reachable: false, evidence: "unreachable" } },
      breakdown,
    };
  } catch (err) {
    return fetchLocalAgentCapacity();
  }
}

async function fetchLocalAgentCapacity() {
  const now = new Date().toISOString();
  const psResult = await runCommand("ps aux --no-headers 2>/dev/null || ps aux | grep -v grep", 3000);
  const psOutput = psResult.success ? psResult.output : "";

  const agents = [
    { id: "qwen-reviewer", name: "Qwen 3.6 Reviewer", role: "Reviewer", status: psOutput.includes("qwen") ? "online" : "offline", evidence: psOutput.includes("qwen") ? "Process detected" : "No process" },
    { id: "claude-assistant", name: "Claude Code", role: "Assistant", status: psOutput.includes("claude") ? "online" : "offline", evidence: psOutput.includes("claude") ? "Process detected" : "No process" },
    { id: "codex-coder", name: "Codex Coder", role: "Coder", status: psOutput.includes("codex") ? "online" : "offline", evidence: psOutput.includes("codex") ? "Process detected" : "No process" },
    { id: "hermes-cto", name: "Hermes CTO", role: "Orchestrator", status: "online", evidence: "This session" },
    { id: "gemini-researcher", name: "Gemini Researcher", role: "Research", status: "offline", evidence: "No process" },
  ];

  const activeCount = agents.filter((a) => a.status === "online").length;

  return {
    status: activeCount > 0 ? "info" : "neutral",
    label: activeCount > 0 ? `${activeCount} agents active` : "No agents active",
    evidence_timestamp: now,
    active_sessions: activeCount,
    agents,
    platform_health: [],
    sync_status: { droplet: { reachable: false, evidence: "unreachable" }, msi: { reachable: false, evidence: "unreachable" } },
    breakdown: { online: activeCount, busy: 0, idle: 0, offline: 5 - activeCount },
  };
}

async function fetchAlerts() {
  // S4: real alerts from /api/mission-control/alerts
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/alerts`, {
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return {
      status: data.global_severity === "healthy" ? "info" : data.global_severity === "critical" ? "critical" : data.global_severity === "warning" ? "warning" : "info",
      label: `${data.summary.critical} critical · ${data.summary.warning} warning · ${data.summary.info} info`,
      evidence_timestamp: data.timestamp ?? null,
      alerts: (data.alerts ?? []).slice(0, 20).map((a: any) => ({
        id: a.id,
        severity: a.severity,
        title: a.title,
        message: a.message,
        source: a.source,
        timestamp: a.timestamp,
        actionable: a.actionable,
        link: a.link,
      })),
      summary: data.summary,
      slack_status: data.slack_status,
    };
  } catch (err) {
    return {
      status: "warning",
      label: "Alerts unavailable",
      evidence_timestamp: null,
      alerts: [],
      summary: { total: 0, critical: 0, warning: 0, info: 0 },
      slack_status: { name: "dashboard-issues", status: "unreachable", recent_count: 0, evidence: "Alerts check failed" },
    };
  }
}

async function fetchApprovalsRequired() {
  // S4: real approval gates from /api/mission-control/approvals
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/approvals`, {
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return {
      status: "active",
      label: `${data.summary.pending} pending approvals`,
      evidence_timestamp: data.timestamp ?? null,
      count: data.summary.total,
      items: (data.approvals ?? []).map((a: any) => ({
        title: a.title,
        evidence: a.evidence ?? a.description ?? "",
        recommendation: a.priority === "high" ? "review immediately" : "review when available",
        source: a.source,
        requested_by: a.requested_by,
        url: a.url,
        priority: a.priority,
      })),
      summary: data.summary,
    };
  } catch (err) {
    // Fallback: local-only detection
    return {
      status: "active",
      label: "Local check only",
      evidence_timestamp: new Date().toISOString(),
      count: 0,
      items: [],
      summary: { total: 0, pending: 0, urgent: 0 },
    };
  }
}

async function fetchProductionTrust() {
  // S6: real freshness + integrity + deploy checks
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S6)",
    evidence_timestamp: null,
    trust_score: null,
    freshness: [],
    integrity: { score: null, mismatches: 0, last_recon: null },
    deployments: { railway: null, vercel: null },
  };
}

async function fetchLiveAgentOps() {
  // S3: real agent status from agent-capacity endpoint
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/agent-capacity`, {
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return {
      status: data.global_status === "healthy" ? "info" : "warning",
      label: data.global_status === "healthy" ? "All agents operational" : "Some agents offline",
      evidence_timestamp: data.timestamp ?? null,
      agents: (data.agents ?? []).map((a: any) => ({
        name: a.name,
        role: a.role,
        status: a.status,
        evidence: a.evidence,
        criticality: a.criticality,
      })),
      breakdown: data.breakdown ?? {},
      platform_health: data.platform_health ?? [],
    };
  } catch (err) {
    // Fallback: local-only agent detection
    const now = new Date().toISOString();
    const psResult = await runCommand("ps aux --no-headers 2>/dev/null || ps aux | grep -v grep", 3000);
    const psOutput = psResult.success ? psResult.output : "";

    const agents = [
      { name: "Qwen 3.6 Reviewer", role: "Reviewer", status: psOutput.includes("qwen") ? "online" : "offline", evidence: psOutput.includes("qwen") ? "Process detected" : "No process", criticality: "critical" },
      { name: "Claude Code", role: "Assistant", status: psOutput.includes("claude") ? "online" : "offline", evidence: psOutput.includes("claude") ? "Process detected" : "No process", criticality: "high" },
      { name: "Codex Coder", role: "Coder", status: psOutput.includes("codex") ? "online" : "offline", evidence: psOutput.includes("codex") ? "Process detected" : "No process", criticality: "critical" },
      { name: "Hermes CTO", role: "Orchestrator", status: "online", evidence: "This session", criticality: "critical" },
      { name: "Gemini Researcher", role: "Research", status: "offline", evidence: "No process", criticality: "medium" },
    ];

    return {
      status: "active",
      label: "Local detection only",
      evidence_timestamp: now,
      agents,
      breakdown: { online: agents.filter((a: any) => a.status === "online").length, offline: agents.filter((a: any) => a.status === "offline").length },
      platform_health: [],
    };
  }
}

async function fetchActiveTasks() {
  // S5: real kanban DAG from /api/mission-control/tasks
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/tasks`, {
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return {
      status: data.critical > 0 ? "critical" : data.active > 0 ? "info" : "neutral",
      label: `${data.active} active tasks · ${data.critical} critical`,
      evidence_timestamp: data.timestamp ?? null,
      count: data.active,
      items: (data.tasks ?? []).slice(0, 10).map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner,
        updated_at: t.updated_at,
        source: t.source,
        priority: t.priority,
      })),
      runbooks: (data.runbooks ?? []).map((r: any) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        description: r.description,
        affected_system: r.affected_system,
        steps: r.steps,
      })),
      sources: data.sources,
    };
  } catch (err) {
    return {
      status: "pending",
      label: "Tasks unavailable",
      evidence_timestamp: null,
      count: 0,
      items: [],
      runbooks: [],
      sources: {},
    };
  }
}

async function fetchEventStream() {
  // S7: real event stream
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S7)",
    evidence_timestamp: null,
    events: [],
  };
}

async function fetchResearchIntelligence() {
  // S8: real research findings from Qdrant
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S8)",
    evidence_timestamp: null,
    findings: [],
  };
}

/* - helpers - */

function parseResult<T>(result: PromiseSettledResult<T>): T | { error: string } {
  if (result.status === "fulfilled") return result.value;
  return { error: result.reason?.message ?? "Unknown error" };
}

async function readCpuLoad(): Promise<{ load: number }> {
  try {
    const result = await runCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", 3000);
    if (result.success) {
      const load = parseFloat(result.output);
      return { load: isNaN(load) ? 0 : load };
    }
  } catch { /* fall through */ }
  return { load: 0 };
}

async function readMemoryInfo(): Promise<{ used: number; total: number; percent: number }> {
  try {
    const result = await runCommand("free -m | awk '/^Mem:/{print $2, $3}'", 3000);
    if (result.success) {
      const parts = result.output.trim().split(/\s+/);
      const total = parseFloat(parts[0]) || 1;
      const used = parseFloat(parts[1]) || 0;
      return {
        used: Math.round(used / 1024 * 100) / 100,
        total: Math.round(total / 1024 * 100) / 100,
        percent: Math.round((used / total) * 100),
      };
    }
  } catch { /* fall through */ }
  return { used: 0, total: 0, percent: 0 };
}

async function readDiskInfo(mount: string): Promise<{ used: number; total: number; percent: number }> {
  try {
    const result = await runCommand(`df -m ${mount} | awk 'NR==2{print $2, $3}'`, 3000);
    if (result.success) {
      const parts = result.output.trim().split(/\s+/);
      const total = parseFloat(parts[0]) || 1;
      const used = parseFloat(parts[1]) || 0;
      return {
        used: Math.round(used / 1024 * 100) / 100,
        total: Math.round(total / 1024 * 100) / 100,
        percent: Math.round((used / total) * 100),
      };
    }
  } catch { /* fall through */ }
  return { used: 0, total: 0, percent: 0 };
}

interface CmdResult {
  success: boolean;
  output: string;
  error?: string;
}

function runCommand(cmd: string, timeout: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const proc = spawn(cmd, { shell: true });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 100);
      resolve({ success: false, output: "", error: `Timeout after ${timeout}ms` });
    }, timeout);

    proc.on("close", (code: number) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr.trim() || `Exit code ${code}` });
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ success: false, output: "", error: err.message });
    });
  });
}
