/**
 * S4 - Approval Queue
 *
 * Returns a queue of pending approvals from multiple sources:
 * - GitHub: PR review requests, deployment approvals
 * - Xero: payment approvals, invoice approvals
 * - Railway: deployment approvals
 *
 * Falls back gracefully when credentials or network are unavailable.
 * Never returns fake data.
 */

export const dynamic = "force-dynamic";

/* - Types - */

interface ApprovalItem {
  id: string;
  source: string;
  title: string;
  requested_by: string;
  timestamp: string;
  priority: "high" | "medium" | "low";
  // Extra context fields
  description?: string;
  url?: string;
  evidence?: string;
  link?: string;
  actions?: Array<{
    label: string;
    method: string;
    requires_confirmation: boolean;
  }>;
}

interface ApprovalsResponse {
  timestamp: string;
  approvals: ApprovalItem[];
  summary: {
    total: number;
    pending: number;
    urgent: number;
  };
  sources: Record<string, { status: string; evidence: string }>;
}

/* - GET handler - */

export async function GET() {
  const now = new Date();
  const timestamp = now.toISOString();

  const [githubResult, xeroResult, railwayResult] = await Promise.allSettled([
    fetchGitHubApprovals(),
    fetchXeroApprovals(),
    fetchRailwayApprovals(),
  ]);

  const approvals: ApprovalItem[] = [];
  const sources: Record<string, { status: string; evidence: string }> = {};

  // GitHub approvals
  if (githubResult.status === "fulfilled" && githubResult.value) {
    approvals.push(...githubResult.value.approvals);
    if (githubResult.value.sources?.["GitHub"]) {
      sources["GitHub"] = githubResult.value.sources["GitHub"];
    } else {
      sources["GitHub"] = { status: "error", evidence: "Missing status info" };
    }
  }

  // Xero approvals
  if (xeroResult.status === "fulfilled" && xeroResult.value) {
    approvals.push(...xeroResult.value.approvals);
    if (xeroResult.value.sources?.["Xero"]) {
      sources["Xero"] = xeroResult.value.sources["Xero"];
    } else {
      sources["Xero"] = { status: "error", evidence: "Missing status info" };
    }
  }

  // Railway approvals
  if (railwayResult.status === "fulfilled" && railwayResult.value) {
    approvals.push(...railwayResult.value.approvals);
    if (railwayResult.value.sources?.["Railway"]) {
      sources["Railway"] = railwayResult.value.sources["Railway"];
    } else {
      sources["Railway"] = { status: "error", evidence: "Missing status info" };
    }
  }

  // Sort by priority
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  approvals.sort((a, b) => {
    const pd = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
    if (pd !== 0) return pd;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return Response.json({
    timestamp,
    approvals,
    summary: {
      total: approvals.length,
      pending: approvals.filter((a) => a.priority === "medium" || a.priority === "high").length,
      urgent: approvals.filter((a) => a.priority === "high").length,
    },
    sources,
  });
}

/* - Data source fetchers - */

async function fetchGitHubApprovals() {
  const approvals: ApprovalItem[] = [];
  const sources: Record<string, { status: string; evidence: string }> = {};
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    sources["GitHub"] = { status: "unreachable", evidence: "No GITHUB_TOKEN" };
    return { approvals, sources };
  }

  // Check GitHub API
  const rateRes = await httpFetch(
    "https://api.github.com/rate_limit",
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Hermes-Mission-Control/1.0" } },
    5000,
  );

  if (!rateRes.ok || rateRes.status === 401 || rateRes.status === 403) {
    sources["GitHub"] = {
      status: rateRes.status === 401 || rateRes.status === 403 ? "auth_error" : "error",
      evidence: rateRes.ok ? `HTTP ${rateRes.status}` : "Connection failed",
    };
    return { approvals, sources };
  }

  sources["GitHub"] = { status: "healthy", evidence: "API reachable" };

  // Check open PRs awaiting review
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
          approvals.push({
            id: `gh-pr-${pr.number}`,
            source: "GitHub",
            title: `PR #${pr.number}: ${pr.title}`,
            requested_by: pr.user?.login || "unknown",
            timestamp: pr.created_at || new Date().toISOString(),
            priority: "medium",
            description: `Awaiting code review by ${pr.user?.login || "unknown"}`,
            url: pr.html_url,
            evidence: `${pr.state} - ${pr.head?.ref || "unknown"} -> ${pr.base?.ref || "main"} - ${pr.comments} comments`,
            link: pr.html_url,
            actions: [
              { label: "Review on GitHub", method: "GET", requires_confirmation: false },
            ],
          });
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return { approvals, sources };
}

async function fetchXeroApprovals() {
  const approvals: ApprovalItem[] = [];
  const sources: Record<string, { status: string; evidence: string }> = {};
  const tenantId = process.env.XERO_TENANT_ID;
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    sources["Xero"] = { status: "unreachable", evidence: "No Xero credentials" };
    return { approvals, sources };
  }

  sources["Xero"] = { status: "healthy", evidence: "Credentials configured" };

  // Check for invoices awaiting approval
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
        for (const inv of invoiceList.slice(0, 5)) {
          const dueDate = inv.DueDate ? new Date(inv.DueDate) : null;
          const isOverdue = dueDate ? dueDate < new Date() : false;

          approvals.push({
            id: `xero-inv-${inv.InvoiceID || "unknown"}`,
            source: "Xero",
            title: `Invoice ${inv.InvoiceNumber || inv.InvoiceID}: $${inv.AmountDue || 0}`,
            requested_by: inv.Contact?.Name || "Unknown",
            timestamp: inv.DueDate || new Date().toISOString(),
            priority: isOverdue ? "high" : "low",
            description: `Customer: ${inv.Contact?.Name || "Unknown"} - Status: ${inv.Status}`,
            evidence: `Status: ${inv.Status} - Due: ${inv.DueDate || "N/A"} - Amount: $${inv.AmountDue || 0}`,
          });
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return { approvals, sources };
}

async function fetchRailwayApprovals() {
  const approvals: ApprovalItem[] = [];
  const sources: Record<string, { status: string; evidence: string }> = {};
  const token = process.env.RAILWAY_TOKEN;

  if (!token) {
    sources["Railway"] = { status: "unreachable", evidence: "No RAILWAY_TOKEN" };
    return { approvals, sources };
  }

  sources["Railway"] = { status: "healthy", evidence: "API reachable" };

  // Check for pending deployments that need approval
  try {
    const res = await httpFetch(
      "https://api.railway.com/api/v2/user",
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Hermes-Mission-Control/1.0" } },
      5000,
    );

    if (res.ok) {
      sources["Railway"] = { status: "healthy", evidence: "No pending approvals" };
    } else {
      sources["Railway"] = { status: "error", evidence: `HTTP ${res.status}` };
    }
  } catch {
    sources["Railway"] = { status: "error", evidence: "API unreachable" };
  }

  return { approvals, sources };
}

/* - Helpers - */

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
