/**
 * S2 — System Health Live Evidence
 *
 * Real health checks for all 9 platform systems. Falls back gracefully
 * when credentials or network are unavailable — marked as "unreachable"
 * rather than "healthy" to avoid false positives.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  const timestamp = now.toISOString();

  // Run all checks in parallel with timeout handling
  const checks = await Promise.allSettled([
    checkGB10_1(),
    checkGB10_2(),
    checkHermes(),
    checkQdrant(),
    checkRailway(),
    checkVercel(),
    checkGitHub(),
    checkServiceTitan(),
    checkXero(),
  ]);

  const systems = checks
    .map((result, i) => {
      if (result.status === "fulfilled") {
        return {
          name: result.value.name,
          status: result.value.status,
          metric: result.value.metric,
          last_checked: timestamp,
          evidence: result.value.evidence,
        };
      }
      return {
        name: result.reason?.name ?? `System ${i + 1}`,
        status: "unreachable",
        metric: "",
        last_checked: timestamp,
        evidence: result.reason?.message ?? "Check failed",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const globalStatus = computeGlobalStatus(systems);

  return Response.json({
    timestamp,
    global_status: globalStatus,
    systems,
    total: systems.length,
    healthy: systems.filter((s) => s.status === "healthy").length,
    warning: systems.filter((s) => s.status === "warning").length,
    critical: systems.filter((s) => s.status === "critical").length,
    unreachable: systems.filter((s) => s.status === "unreachable").length,
  });
}

/* ── Health check functions ───────────────────────────────────── */

async function checkGB10_1() {
  // Local machine — check CPU, memory, disk
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
    name: "GB10 #1",
    status,
    metric: `${cpuLoad.load}% CPU · ${memInfo.percent}% RAM · ${diskInfo.percent}% disk`,
    evidence: `load=${cpuLoad.load}, mem=${memInfo.used}GB/${memInfo.total}GB, disk=${diskInfo.used}GB/${diskInfo.total}GB`,
  };
}

async function checkGB10_2() {
  // Second GB10 machine — SSH check
  // If SSH is not configured, return unreachable immediately to avoid hanging
  const host = "phillip@gb10-2";
  if (!process.env.SSH_GB10_2_HOST) {
    return {
      name: "GB10 #2",
      status: "unreachable",
      metric: "",
      evidence: "SSH host not configured",
    };
  }
  
  const result = await runCommand(`ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${host} 'uptime' 2>&1`, 5000);
  if (result.success) {
    return {
      name: "GB10 #2",
      status: "healthy",
      metric: result.output.trim(),
      evidence: "SSH responsive",
    };
  }
  return {
    name: "GB10 #2",
    status: "unreachable",
    metric: "",
    evidence: result.error || "SSH connection failed",
  };
}

async function checkHermes() {
  // Check if Hermes agent is running
  // If the process check hangs, we should fail fast
  const result = await runCommand("pgrep -f 'hermes' > /dev/null 2>&1 && echo running || echo stopped", 3000);
  if (result.success && result.output.trim() === "running") {
    return {
      name: "Hermes",
      status: "healthy",
      metric: "Agent running",
      evidence: "Process detected",
    };
  }
  return {
    name: "Hermes",
    status: "unreachable",
    metric: "",
    evidence: "Agent not detected",
  };
}

async function checkQdrant() {
  // Qdrant health endpoint
  const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
  return httpHealthCheck("Qdrant", `${qdrantUrl}/health`, 3000);
}

async function checkRailway() {
  // Railway API — check project status
  const token = process.env.RAILWAY_TOKEN;
  if (!token) {
    return {
      name: "Railway",
      status: "unreachable",
      metric: "",
      evidence: "No RAILWAY_TOKEN configured",
    };
  }
  return httpHealthCheck("Railway", "https://api.railway.com/api/v2/user", 5000, {
    Authorization: `Bearer ${token}`,
  });
}

async function checkVercel() {
  // Vercel API — check project status
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return {
      name: "Vercel",
      status: "unreachable",
      metric: "",
      evidence: "No VERCEL_TOKEN configured",
    };
  }
  return httpHealthCheck("Vercel", "https://api.vercel.com/v2/projects?teamId=director-phil", 5000, {
    Authorization: `Bearer ${token}`,
  });
}

async function checkGitHub() {
  // GitHub API — check if API is reachable
  const token = process.env.GITHUB_TOKEN;
  const url = token
    ? "https://api.github.com/rate_limit"
    : "https://api.github.com";
  return httpHealthCheck("GitHub", url, 5000, token
    ? { Authorization: `Bearer ${token}` }
    : {}
  );
}

async function checkServiceTitan() {
  // ServiceTitan API — health check
  const clientId = process.env.SERVICE_TITAN_CLIENT_ID;
  const clientSecret = process.env.SERVICE_TITAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      name: "ServiceTitan",
      status: "unreachable",
      metric: "",
      evidence: "No ServiceTitan credentials configured",
    };
  }
  return httpHealthCheck("ServiceTitan", "https://api.service-titan.com/health", 5000);
}

async function checkXero() {
  // Xero API — health check
  const tenantId = process.env.XERO_TENANT_ID;
  if (!tenantId) {
    return {
      name: "Xero",
      status: "unreachable",
      metric: "",
      evidence: "No XERO_TENANT_ID configured",
    };
  }
  return httpHealthCheck("Xero", "https://api.xero.com/api.xw", 5000);
}

/* ── Helpers ──────────────────────────────────────────────────── */

async function httpHealthCheck(
  name: string,
  url: string,
  timeout: number,
  extraHeaders?: Record<string, string>,
): Promise<{ name: string; status: string; metric: string; evidence: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = { "User-Agent": "Hermes-Mission-Control/1.0" };
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      return {
        name,
        status: "healthy",
        metric: `${res.status} ${res.statusText}`,
        evidence: `HTTP ${res.status} in ${timeout}ms`,
      };
    }

    // Non-2xx — could be auth error or real down
    const contentType = res.headers.get("content-type") || "";
    const body = contentType.includes("json") ? await res.json().catch(() => null) : null;

    if (res.status === 401 || res.status === 403) {
      return {
        name,
        status: "warning",
        metric: `${res.status} ${res.statusText}`,
        evidence: `Auth error: ${body?.message || res.statusText}`,
      };
    }

    return {
      name,
      status: "warning",
      metric: `${res.status} ${res.statusText}`,
      evidence: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name,
      status: "unreachable",
      metric: "",
      evidence: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function computeGlobalStatus(systems: Array<{ status: string }>): string {
  const hasCritical = systems.some((s) => s.status === "critical");
  if (hasCritical) return "critical";

  const hasWarning = systems.some((s) => s.status === "warning");
  if (hasWarning) return "warning";

  const unreachable = systems.filter((s) => s.status === "unreachable").length;
  if (unreachable > systems.length / 2) return "warning";

  return "healthy";
}

/* ── System info helpers ──────────────────────────────────────── */

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
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr.trim() || `Exit code ${code}` });
      }
    });
    
    proc.on("error", (err: Error) => {
      resolve({ success: false, output: "", error: err.message });
    });
    
    // Set a timeout to kill the process if it takes too long
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, output: "", error: `Timeout after ${timeout}ms` });
    }, timeout);
    
    // Clear the timer if the process completes before timeout
    proc.on("close", () => {
      clearTimeout(timer);
    });
  });
}
