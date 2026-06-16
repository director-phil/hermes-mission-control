/**
 * S5 — Active Tasks & Runbooks API
 *
 * Aggregates tasks from GitHub, local cron jobs, running processes,
 * and auto-generates runbooks from system health data.
 */

interface TaskItem {
  id: string;
  title: string;
  status: string;
  owner: string;
  updated_at: string;
  source: string;
  priority: string;
}

interface RunbookItem {
  id: string;
  title: string;
  severity: string;
  description: string;
  affected_system: string;
  steps: string[];
}

interface TasksResponse {
  timestamp: string;
  total: number;
  active: number;
  critical: number;
  sources: {
    github: { status: string; count: number; evidence: string };
    cron: { status: string; count: number; evidence: string };
    processes: { status: string; count: number; evidence: string };
    health: { status: string; count: number; evidence: string };
  };
  tasks: TaskItem[];
  runbooks: RunbookItem[];
}

async function fetchGitHubTasks(): Promise<{ tasks: TaskItem[] }> {
  const tasks: TaskItem[] = [];
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { tasks: [] };

    const repo = process.env.GITHUB_REPO || "director-phil/hermes-mission-control";
    const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=20`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { tasks: [] };
    const issues: Array<{ number: number; title: string; state: string; updated_at: string; labels: Array<{ name: string }> }> = await res.json();

    for (const issue of issues) {
      const priority = issue.labels.some(l => l.name === "critical") ? "critical"
        : issue.labels.some(l => l.name === "high") ? "high"
        : issue.labels.some(l => l.name === "medium") ? "medium"
        : "low";

      tasks.push({
        id: `gh-${issue.number}`,
        title: issue.title,
        status: issue.state,
        owner: "unassigned",
        updated_at: issue.updated_at,
        source: "github",
        priority,
      });
    }
  } catch {
    // Return empty on failure
  }
  return { tasks };
}

async function fetchLocalCronTasks(): Promise<{ tasks: TaskItem[] }> {
  const tasks: TaskItem[] = [];
  try {
    const { exec } = await import("child_process");
    const result = await new Promise<string>((resolve, reject) => {
      exec("crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' || true", { timeout: 5000 }, (err, stdout) => {
        if (err) resolve("");
        else resolve(stdout || "");
      });
    });

    const lines = (result || "").split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const cmd = parts.slice(5).join(" ");
      tasks.push({
        id: `cron-${btoa(line).slice(0, 8)}`,
        title: cmd || "cron job",
        status: "active",
        owner: "cron",
        updated_at: new Date().toISOString(),
        source: "cron",
        priority: "low",
      });
    }
  } catch {
    // Return empty on failure
  }
  return { tasks };
}

async function fetchLocalProcessTasks(): Promise<{ tasks: TaskItem[] }> {
  const tasks: TaskItem[] = [];
  try {
    const { exec } = await import("child_process");
    const result = await new Promise<string>((resolve, reject) => {
      exec("ps aux | grep -E '(node|python|hermes|qwen|codex)' | grep -v grep || true", { timeout: 5000 }, (err, stdout) => {
        if (err) resolve("");
        else resolve(stdout || "");
      });
    });

    const lines = (result || "").split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const cmd = parts.slice(10).join(" ");
      if (cmd.includes("grep") || cmd.includes("ps")) continue;
      tasks.push({
        id: `proc-${btoa(cmd).slice(0, 8)}`,
        title: cmd.slice(0, 60) || "process",
        status: "running",
        owner: "system",
        updated_at: new Date().toISOString(),
        source: "processes",
        priority: "low",
      });
    }
  } catch {
    // Return empty on failure
  }
  return { tasks };
}

async function fetchHealthRunbooks(): Promise<{ runbooks: RunbookItem[] }> {
  const runbooks: RunbookItem[] = [];

  try {
    const healthUrl = `${process.env.VERCEL_URL || "http://localhost:3000"}/api/mission-control/system-health`;
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { runbooks: [] };
    const health = await res.json();

    if (health.systems) {
      for (const sys of health.systems) {
        if (sys.status === "critical" || sys.status === "warning") {
          runbooks.push({
            id: `rb-${sys.name}`,
            title: `${sys.name} — ${sys.status.toUpperCase()}`,
            severity: sys.status,
            description: sys.evidence || `System ${sys.name} is in ${sys.status} state`,
            affected_system: sys.name,
            steps: [
              `1. Check ${sys.name} health endpoint`,
              `2. Review recent logs for ${sys.name}`,
              `3. Verify network connectivity`,
              `4. Check resource utilization (CPU, memory, disk)`,
              `5. Restart if necessary`,
            ],
          });
        }
      }
    }
  } catch {
    // Return empty on failure
  }

  return { runbooks };
}

export async function GET() {
  const now = new Date().toISOString();
  const [githubResult, cronResult, processResult, healthResult] =
    await Promise.allSettled([
      fetchGitHubTasks(),
      fetchLocalCronTasks(),
      fetchLocalProcessTasks(),
      fetchHealthRunbooks(),
    ]);

  const githubTasks: TaskItem[] =
    githubResult.status === "fulfilled" ? githubResult.value.tasks : [];
  const cronTasks: TaskItem[] =
    cronResult.status === "fulfilled" ? cronResult.value.tasks : [];
  const processTasks: TaskItem[] =
    processResult.status === "fulfilled" ? processResult.value.tasks : [];
  const runbooks: RunbookItem[] =
    healthResult.status === "fulfilled" ? healthResult.value.runbooks : [];

  const allTasks = [...githubTasks, ...cronTasks, ...processTasks];
  const activeTasks = allTasks.filter((t) => t.status !== "completed" && t.status !== "closed");
  const criticalTasks = allTasks.filter((t) => t.priority === "critical");

  return Response.json({
    timestamp: now,
    total: allTasks.length,
    active: activeTasks.length,
    critical: criticalTasks.length + runbooks.length,
    sources: {
      github: { status: githubResult.status === "fulfilled" ? "ok" : "error", count: githubTasks.length, evidence: githubResult.status === "fulfilled" ? githubTasks.length + " issues found" : "Failed to fetch" },
      cron: { status: cronResult.status === "fulfilled" ? "ok" : "error", count: cronTasks.length, evidence: cronResult.status === "fulfilled" ? cronTasks.length + " active jobs" : "Failed to fetch" },
      processes: { status: processResult.status === "fulfilled" ? "ok" : "error", count: processTasks.length, evidence: processResult.status === "fulfilled" ? processTasks.length + " sync processes" : "Failed to fetch" },
      health: { status: healthResult.status === "fulfilled" ? "ok" : "error", count: runbooks.length, evidence: healthResult.status === "fulfilled" ? runbooks.length + " auto-generated runbooks" : "Failed to fetch" },
    },
    tasks: allTasks,
    runbooks,
  } as TasksResponse);
}
