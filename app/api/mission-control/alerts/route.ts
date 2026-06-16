/**
 * S4 - Alerts Aggregator
 *
 * Collects alerts from multiple data sources:
 * - GitHub: pending PRs, failed CI builds
 * - System health: correlates health check results into alerts
 * - Xero: reconciliation issues
 * - Slack: recent messages from #dashboard-issues (if API available)
 * - Railway: deployment alerts
 *
 * Falls back gracefully when credentials or network are unavailable.
 * Never returns fake data - missing sources are marked as "unreachable".
 */

export const dynamic = "force-dynamic";

/* - Types - */

interface Alert {
  id: string;
  source: string;
  severity: "info" | "warning" | "critical";
  message: string;
  timestamp: string;
  actionable: boolean;
  title?: string;
  evidence?: string;
  link?: string;
}

interface SlackChannel {
  name: string;
  status: "healthy" | "warning" | "unreachable";
  recent_count: number;
  evidence: string;
}

interface AlertsResponse {
  timestamp: string;
  global_severity: "info" | "warning" | "critical" | "healthy";
  alerts: Alert[];
  slack_status: SlackChannel;
  summary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
}

/* - GET handler - */

export async function GET() {
  const now = new Date();
  const timestamp = now.toISOString();

  const [healthData, githubAlerts, xeroAlerts, railwayAlerts, slackStatus] =
    await Promise.allSettled([
      fetchSystemHealth(),
      fetchGitHubAlerts(),
      fetchXeroAlerts(),
      fetchRailwayAlerts(),
      fetchSlackStatus(),
    ]);

  const alerts: Alert[] = [];

  if (healthData.status === "fulfilled" && healthData.value) {
    const health = healthData.value;
    if (health.global_status === "critical") {
      alerts.push({
        id: `health-critical-${Date.now()}`,
        source: "System Health",
        severity: "critical",
        message: `Global status: ${health.global_status}`,
        timestamp: health.timestamp,
        actionable: true,
        title: "Critical system health",
        evidence: `${health.critical} critical, ${health.warning} warning, ${health.unreachable} unreachable of ${health.total} systems`,
        link: "/mission-control",
      });
    } else if (health.global_status === "warning") {
      alerts.push({
        id: `health-warning-${Date.now()}`,
        source: "System Health",
        severity: "warning",
        message: `Global status: ${health.global_status}`,
        timestamp: health.timestamp,
        actionable: true,
        title: "Warning system health",
        evidence: `${health.warning} warning, ${health.unreachable} unreachable of ${health.total} systems`,
        link: "/mission-control",
      });
    }

    if (Array.isArray(health.systems)) {
      for (const sys of health.systems) {
        if (sys.status === "critical") {
          alerts.push({
            id: `health-${sys.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
            source: "System Health",
            severity: "critical",
            message: `System ${sys.name} is in critical state`,
            timestamp: sys.last_checked,
            actionable: true,
            title: `${sys.name} critical`,
            evidence: sys.evidence,
            link: "/mission-control",
          });
        } else if (sys.status === "unreachable") {
          alerts.push({
            id: `health-${sys.name.toLowerCase().replace(/\s+/g, "-")}-unreach-${Date.now()}`,
            source: "System Health",
            severity: "warning",
            message: `System ${sys.name} is unreachable`,
            timestamp: sys.last_checked,
            actionable: false,
            title: `${sys.name} unreachable`,
            evidence: sys.evidence,
            link: "/mission-control",
          });
        }
      }
    }
  }

  if (githubAlerts.status === "fulfilled" && githubAlerts.value) {
    alerts.push(...githubAlerts.value);
  }
  if (xeroAlerts.status === "fulfilled" && xeroAlerts.value) {
    alerts.push(...xeroAlerts.value);
  }
  if (railwayAlerts.status === "fulfilled" && railwayAlerts.value) {
    alerts.push(...railwayAlerts.value);
  }

  const slackStatusResult =
    slackStatus.status === "fulfilled" ? slackStatus.value : defaultSlackStatus();

  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const globalSeverity = computeGlobalSeverity(alerts);

  return Response.json({
    timestamp,
    global_severity: globalSeverity,
    alerts: alerts.slice(0, 50),
    slack_status: slackStatusResult,
    summary: {
      total: alerts.length,
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
    },
  });
}

/* - Data source fetchers - */

async function fetchSystemHealth() {
  try {
    const baseUrl = process.env.VERCEL_URL || "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/mission-control/system-health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchGitHubAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    alerts.push({
      id: "github-no-token",
      source: "GitHub",
      severity: "info",
      message: "GITHUB_TOKEN not set - GitHub alerts unavailable",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "GitHub integration not configured",
      evidence: "No GITHUB_TOKEN in environment",
    });
    return alerts;
  }

  const rateRes = await httpFetch(
    "https://api.github.com/rate_limit",
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Hermes-Mission-Control/1.0" } },
    5000,
  );

  if (!rateRes.ok || rateRes.status === 401 || rateRes.status === 403) {
    alerts.push({
      id: "github-auth-error",
      source: "GitHub",
      severity: "warning",
      message: "Unable to authenticate with GitHub API",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "GitHub auth failed",
      evidence: rateRes.ok ? `HTTP ${rateRes.status}` : "Connection failed",
    });
    return alerts;
  }

  try {
    const prRes = await httpFetch(
      "https://api.github.com/repos/director-phil/hermes-mission-control/pulls?state=open&per_page=10",
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Hermes-Mission-Control/1.0" } },
      5000,
    );

    if (prRes.ok) {
      const prs = await prRes.json();
      if (Array.isArray(prs) && prs.length > 0) {
        for (const pr of prs.slice(0, 5)) {
          alerts.push({
            id: `gh-pr-${pr.number}`,
            source: "GitHub",
            severity: "info",
            message: `Open PR by ${pr.user?.login || "unknown"}`,
            timestamp: pr.updated_at || pr.created_at || new Date().toISOString(),
            actionable: true,
            title: `PR #${pr.number}: ${pr.title}`,
            evidence: `${pr.state} - ${pr.head?.ref || "unknown"} -> ${pr.base?.ref || "main"}`,
            link: pr.html_url,
          });
        }
      }
    }
  } catch {
    // Non-fatal
  }

  try {
    const runsRes = await httpFetch(
      "https://api.github.com/repos/director-phil/hermes-mission-control/actions/runs?per_page=10",
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Hermes-Mission-Control/1.0" } },
      5000,
    );

    if (runsRes.ok) {
      const runs = await runsRes.json();
      if (Array.isArray(runs?.workflow_runs)) {
        for (const run of runs.workflow_runs) {
          if (run.conclusion === "failure") {
            alerts.push({
              id: `gh-ci-${run.id}`,
              source: "GitHub",
              severity: "warning",
              message: `Workflow run failed for ${run.head_branch || "unknown branch"}`,
              timestamp: run.created_at || new Date().toISOString(),
              actionable: true,
              title: `CI failed: ${run.name}`,
              evidence: `Run #${run.run_number} - ${run.conclusion}`,
              link: run.html_url,
            });
          }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return alerts;
}

async function fetchXeroAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const tenantId = process.env.XERO_TENANT_ID;
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    alerts.push({
      id: "xero-no-config",
      source: "Xero",
      severity: "info",
      message: "Xero credentials not set - reconciliation checks unavailable",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "Xero integration not configured",
      evidence: "Missing XERO_TENANT_ID or XERO_CLIENT_ID/SECRET",
    });
    return alerts;
  }

  const healthRes = await httpFetch(
    "https://api.xero.com/api.xw",
    { headers: { "User-Agent": "Hermes-Mission-Control/1.0" } },
    5000,
  );

  if (healthRes.status === 401 || healthRes.status === 403) {
    alerts.push({
      id: "xero-auth-error",
      source: "Xero",
      severity: "warning",
      message: "Xero API returned auth error",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "Xero auth error",
      evidence: `HTTP ${healthRes.status}`,
    });
    return alerts;
  }

  try {
    const invoicesRes = await httpFetch(
      `https://api.xero.com/api.xw/AccountsReceivable/${tenantId}/Invoices?where=Status=AUTHENTICATED&order=UpdatedDateUTC+DESC&page=1`,
      { headers: { "User-Agent": "Hermes-Mission-Control/1.0" } },
      5000,
    );

    if (invoicesRes.ok) {
      const invoices = await invoicesRes.json();
      const invoiceList = invoices?.Invoices || [];
      if (Array.isArray(invoiceList) && invoiceList.length > 0) {
        const overdue = invoiceList.filter((inv: any) => {
          const dueDate = new Date(inv.DueDate);
          return dueDate < new Date() && inv.Status === "AUTHENTICATED";
        });

        if (overdue.length > 0) {
          alerts.push({
            id: "xero-overdue",
            source: "Xero",
            severity: "warning",
            message: `${overdue.length} authenticated invoice(s) past due date`,
            timestamp: new Date().toISOString(),
            actionable: true,
            title: `${overdue.length} overdue invoice(s)`,
            evidence: `${overdue.length} overdue invoices found`,
          });
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return alerts;
}

async function fetchRailwayAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const token = process.env.RAILWAY_TOKEN;

  if (!token) {
    alerts.push({
      id: "railway-no-token",
      source: "Railway",
      severity: "info",
      message: "RAILWAY_TOKEN not set - deployment alerts unavailable",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "Railway integration not configured",
      evidence: "No RAILWAY_TOKEN in environment",
    });
    return alerts;
  }

  const res = await httpFetch(
    "https://api.railway.com/api/v2/user",
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Hermes-Mission-Control/1.0" } },
    5000,
  );

  if (res.status === 401 || res.status === 403) {
    alerts.push({
      id: "railway-auth-error",
      source: "Railway",
      severity: "warning",
      message: "Unable to authenticate with Railway API",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "Railway auth error",
      evidence: `HTTP ${res.status}`,
    });
    return alerts;
  }

  if (!res.ok) {
    alerts.push({
      id: "railway-unreachable",
      source: "Railway",
      severity: "warning",
      message: "Railway API returned non-2xx status",
      timestamp: new Date().toISOString(),
      actionable: false,
      title: "Railway API unreachable",
      evidence: `HTTP ${res.status}`,
    });
    return alerts;
  }

  return alerts;
}

async function fetchSlackStatus(): Promise<SlackChannel> {
  const slackToken = process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN;

  if (!slackToken) {
    return {
      name: "dashboard-issues",
      status: "unreachable",
      recent_count: 0,
      evidence: "No SLACK_BOT_TOKEN configured",
    };
  }

  try {
    const res = await httpFetch(
      "https://slack.com/api/conversations.history",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
          "User-Agent": "Hermes-Mission-Control/1.0",
        },
        body: JSON.stringify({
          channel: "#dashboard-issues",
          count: 5,
        }),
      },
      5000,
    );

    if (res.ok) {
      const data = await res.json();
      return {
        name: "dashboard-issues",
        status: "healthy",
        recent_count: (data.messages?.length || 0),
        evidence: `${data.messages?.length || 0} recent messages`,
      };
    }

    return {
      name: "dashboard-issues",
      status: "warning",
      recent_count: 0,
      evidence: `Slack API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name: "dashboard-issues",
      status: "unreachable",
      recent_count: 0,
      evidence: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* - Helpers - */

function defaultSlackStatus(): SlackChannel {
  return {
    name: "dashboard-issues",
    status: "unreachable",
    recent_count: 0,
    evidence: "Slack check unavailable",
  };
}

function computeGlobalSeverity(alerts: Alert[]): "info" | "warning" | "critical" | "healthy" {
  const hasCritical = alerts.some((a) => a.severity === "critical");
  if (hasCritical) return "critical";
  const hasWarning = alerts.some((a) => a.severity === "warning");
  if (hasWarning) return "warning";
  if (alerts.length > 0) return "info";
  return "healthy";
}

async function httpFetch(
  url: string,
  options: RequestInit & { headers?: Record<string, string> } = {},
  timeoutMs: number = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": "Hermes-Mission-Control/1.0", ...options.headers },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
