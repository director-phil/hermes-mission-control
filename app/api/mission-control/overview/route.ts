/**
 * S1 — First View Operating Shell (overview endpoint)
 *
 * Aggregates all 8 first-view sections in parallel. S2 wired.
 * Other slices use placeholder data with explicit labels.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date().toISOString();

  const [systemHealth, agentCapacity, approvalsRequired, productionTrust,
          liveAgentOps, activeTasks, eventStream, researchIntelligence] =
    await Promise.allSettled([
      fetchSystemHealth(),
      fetchAgentCapacity(),
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
    approvals_required: parseResult(approvalsRequired),
    production_trust: parseResult(productionTrust),
    live_agent_ops: parseResult(liveAgentOps),
    active_tasks: parseResult(activeTasks),
    event_stream: parseResult(eventStream),
    research_intelligence: parseResult(researchIntelligence),
  });
}

/* ── section fetchers ──────────────────────────────────────────── */

async function fetchSystemHealth() {
  // S2: real health checks — wired
  try {
    const res = await fetch(`${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/system-health`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    // Fallback: local-only checks (no network deps)
    return fetchLocalHealth();
  }
}

async function fetchLocalHealth() {
  // Fallback: check only what's available locally
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
      { name: "GB10 #1", status, metric: `${cpuLoad.load}% CPU · ${memInfo.percent}% RAM · ${diskInfo.percent}% disk`, last_checked: now, evidence: "local" },
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
  // S3: real Hermes session logs
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S3)",
    evidence_timestamp: null,
    active_sessions: 0,
    breakdown: {
      running: 0,
      waiting: 0,
      blocked: 0,
      review: 0,
      completed: 0,
    },
  };
}

async function fetchApprovalsRequired() {
  // S4: real approval gates
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S4)",
    evidence_timestamp: null,
    count: 0,
    items: [],
  };
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
  // S3: real agent status from Hermes
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S3)",
    evidence_timestamp: null,
    agents: [],
  };
}

async function fetchActiveTasks() {
  // S5: real kanban DAG
  // S1: placeholder
  return {
    status: "pending",
    label: "Pending live wiring (S5)",
    evidence_timestamp: null,
    count: 0,
    items: [],
  };
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

/* ── helpers ───────────────────────────────────────────────────── */

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
    const proc = spawn(cmd, { shell: true, timeout });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code: number) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr.trim() || `Exit code ${code}` });
      }
    });

    proc.on("error", (err: Error) => {
      resolve({ success: false, output: "", error: err.message });
    });

    if (timeout > 0) {
      setTimeout(() => {
        proc.kill();
        resolve({ success: false, output: "", error: `Timeout after ${timeout}ms` });
      }, timeout);
    }
  });
}
