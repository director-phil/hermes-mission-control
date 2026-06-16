/**
 * S3 — Agent Capacity Aggregator
 *
 * Real-time data about AI agent pool: process status, platform health,
 * sync status, and deployment info. Falls back gracefully when
 * SSH/API credentials are unavailable.
 */

export const dynamic = "force-dynamic";

/* ── Types ─────────────────────────────────────────────────── */

interface Agent {
  id: string;
  name: string;
  role: string;
  criticality: "critical" | "high" | "medium" | "low";
  status: "online" | "offline" | "busy" | "idle";
  local: boolean;
  sessions: { active: number; max: number };
  last_activity: string | null;
  evidence: string;
}

interface PlatformHealth {
  name: string;
  status: "healthy" | "warning" | "unreachable";
  evidence: string;
}

interface SyncStatus {
  droplet: { reachable: boolean; evidence: string };
  msi: { reachable: boolean; evidence: string };
}

interface Deployment {
  platform: string;
  status: "healthy" | "warning" | "unreachable";
  evidence: string;
}

/* ── Agent pool definitions ────────────────────────────────── */

interface AgentDef {
  id: string;
  name: string;
  role: string;
  criticality: "critical" | "high" | "medium" | "low";
  max_sessions: number;
}

const AGENT_POOL: AgentDef[] = [
  { id: "qwen-reviewer", name: "Qwen 3.6 Reviewer", role: "Reviewer", criticality: "critical", max_sessions: 5 },
  { id: "codex-coder", name: "Codex 30B Coder", role: "Coder", criticality: "critical", max_sessions: 5 },
  { id: "claude-assistant", name: "Claude Code", role: "Assistant", criticality: "high", max_sessions: 10 },
  { id: "hermes-cto", name: "Hermes CTO", role: "Orchestrator", criticality: "critical", max_sessions: 10 },
  { id: "gemini-researcher", name: "Gemini Researcher", role: "Research", criticality: "medium", max_sessions: 5 },
];

/* ── GET handler ───────────────────────────────────────────── */

export async function GET() {
  const now = new Date();
  const timestamp = now.toISOString();

  // Parallel checks
  const results = await Promise.allSettled([
    checkLocalAgents(),
    checkGitHubAPI(),
    checkDropletSSH(),
    checkMSISSH(),
    checkVercelAPI(),
    checkRailwayAPI(),
  ]);

  // Parse results
  const agents: Agent[] = [];
  const platformHealth: PlatformHealth[] = [];
  let syncStatus: SyncStatus = {
    droplet: { reachable: false, evidence: "SSH failed" },
    msi: { reachable: false, evidence: "SSH failed" },
  };
  const deployments: Deployment[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      const data = r.value;
      if (Array.isArray(data)) {
        if (data.length > 0 && "id" in data[0]) {
          agents.push(...(data as Agent[]));
        } else if (data.length > 0 && "name" in data[0]) {
          platformHealth.push(...(data as PlatformHealth[]));
        }
      } else if (typeof data === "object" && data !== null) {
        if ("droplet" in data && "msi" in data) {
          syncStatus = data as SyncStatus;
        }
        if ("platform" in data && "evidence" in data && "status" in data) {
          deployments.push(data as Deployment);
        }
      }
    }
  }

  // Sort agents by criticality
  const criticalityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  agents.sort((a, b) => criticalityOrder[a.criticality] - criticalityOrder[b.criticality]);

  // Compute global status
  const hasCritical = agents.some((a) => a.criticality === "critical" && a.status !== "online");
  const hasWarning = platformHealth.some((p) => p.status === "warning");
  const globalStatus = hasCritical ? "warning" : hasWarning ? "warning" : "healthy";

  const activeAgents = agents.filter((a) => a.status === "online" || a.status === "busy").length;

  // Build breakdown
  const breakdown = {
    online: agents.filter((a) => a.status === "online").length,
    busy: agents.filter((a) => a.status === "busy").length,
    idle: agents.filter((a) => a.status === "idle").length,
    offline: agents.filter((a) => a.status === "offline").length,
  };

  return Response.json({
    timestamp,
    global_status: globalStatus,
    agents,
    platform_health: platformHealth.sort((a, b) => a.name.localeCompare(b.name)),
    sync_status: syncStatus,
    deployments,
    total_agents: agents.length,
    active_agents: activeAgents,
    breakdown,
  });
}

/* ── Check functions ───────────────────────────────────────── */

async function checkLocalAgents(): Promise<Agent[]> {
  const psResult = await runCommand(
    "ps aux --no-headers 2>/dev/null || ps aux | grep -v grep",
    3000,
  );
  const psOutput = psResult.success ? psResult.output : "";

  const agents: Agent[] = [];

  for (const agentDef of AGENT_POOL) {
    const lines = psOutput.split("\n");
    const pattern = agentDef.id.split("-")[0];
    const count = lines.filter((l) => l.includes(pattern)).length;
    const active = Math.min(count, agentDef.max_sessions);

    let status: Agent["status"] = "offline";
    let evidence = "No process detected";

    if (active > 0) {
      status = active >= agentDef.max_sessions ? "busy" : "online";
      evidence = `${active} process(es) detected`;
    }

    agents.push({
      id: agentDef.id,
      name: agentDef.name,
      role: agentDef.role,
      criticality: agentDef.criticality,
      status,
      local: active > 0,
      sessions: { active, max: agentDef.max_sessions },
      last_activity: active > 0 ? new Date().toISOString() : null,
      evidence,
    });
  }

  return agents;
}

async function checkGitHubAPI(): Promise<PlatformHealth[]> {
  const results: PlatformHealth[] = [];

  const ghResult = await httpHealthCheck("https://api.github.com/rate_limit", 3000);
  if (ghResult.status === "healthy") {
    results.push({
      name: "GitHub API",
      status: "healthy",
      evidence: "API reachable",
    });

    const repoResult = await httpHealthCheck(
      "https://api.github.com/repos/director-phil/hermes-mission-control",
      3000,
    );
    if (repoResult.status === "healthy") {
      results.push({
        name: "HMC Repo",
        status: "healthy",
        evidence: "Repository accessible",
      });
    }
  } else {
    results.push({
      name: "GitHub API",
      status: ghResult.status,
      evidence: ghResult.evidence,
    });
  }

  return results;
}

async function checkDropletSSH(): Promise<SyncStatus> {
  const result = await runCommand(
    "ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no droplet 'uptime' 2>&1",
    5000,
  );

  if (result.success) {
    return {
      droplet: { reachable: true, evidence: result.output.trim() },
      msi: { reachable: false, evidence: "SSH failed" },
    };
  }

  return {
    droplet: { reachable: false, evidence: result.error || "SSH connection failed" },
    msi: { reachable: false, evidence: "SSH failed" },
  };
}

async function checkMSISSH(): Promise<SyncStatus> {
  const result = await runCommand(
    "ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no msi 'uptime' 2>&1",
    5000,
  );

  if (result.success) {
    return {
      droplet: { reachable: false, evidence: "SSH failed" },
      msi: { reachable: true, evidence: result.output.trim() },
    };
  }

  return {
    droplet: { reachable: false, evidence: "SSH failed" },
    msi: { reachable: false, evidence: result.error || "SSH connection failed" },
  };
}

async function checkVercelAPI(): Promise<Deployment[]> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return [{ platform: "Vercel", status: "unreachable", evidence: "No VERCEL_TOKEN configured" }];
  }

  const result = await httpHealthCheck(
    "https://api.vercel.com/v2/projects?teamId=director-phil",
    5000,
    { Authorization: `Bearer ${token}` },
  );

  return [{ platform: "Vercel", status: result.status, evidence: result.evidence }];
}

async function checkRailwayAPI(): Promise<Deployment[]> {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) {
    return [{ platform: "Railway", status: "unreachable", evidence: "No RAILWAY_TOKEN configured" }];
  }

  const result = await httpHealthCheck(
    "https://api.railway.com/api/v2/user",
    5000,
    { Authorization: `Bearer ${token}` },
  );

  return [{ platform: "Railway", status: result.status, evidence: result.evidence }];
}

/* ── Helpers ───────────────────────────────────────────────── */

async function httpHealthCheck(
  url: string,
  timeout: number,
  extraHeaders?: Record<string, string>,
): Promise<{ status: "healthy" | "warning" | "unreachable"; evidence: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = { "User-Agent": "Hermes-Mission-Control/1.0" };
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) return { status: "healthy", evidence: `HTTP ${res.status}` };
    if (res.status === 401 || res.status === 403) return { status: "warning", evidence: `Auth error: ${res.status}` };
    return { status: "warning", evidence: `HTTP ${res.status}` };
  } catch (err) {
    return {
      status: "unreachable",
      evidence: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

interface CmdResult {
  success: boolean;
  output: string;
  error?: string;
}

async function runCommand(cmd: string, timeout: number): Promise<CmdResult> {
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
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr.trim() || `Exit code ${code}` });
      }
    });

    proc.on("error", (err: Error) => {
      resolve({ success: false, output: "", error: err.message });
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, output: "", error: `Timeout after ${timeout}ms` });
    }, timeout);
  });
}
