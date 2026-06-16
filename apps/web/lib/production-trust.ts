/**
 * S6 — Production Trust computation (shared module).
 *
 * Used by both /api/mission-control/production-trust/route.ts
 * and /api/mission-control/overview/route.ts.
 */

export interface FreshnessEntry {
  source: string;
  last_sync: string | null;
  staleness_minutes: number;
  acceptable_threshold_minutes: number;
}

export interface IntegrityEntry {
  score: number | null;
  mismatches: number;
  last_recon: string | null;
  source_data_count: number;
  dashboard_count: number;
}

export interface DeploymentsEntry {
  railway_last_deploy: string | null;
  vercel_last_deploy: string | null;
  railway_worker_status: string;
  vercel_deploy_status: string;
}

export interface ProductionTrustResult {
  trust_score: number;
  freshness: FreshnessEntry[];
  integrity: IntegrityEntry;
  deployments: DeploymentsEntry;
}

export async function computeProductionTrust(): Promise<ProductionTrustResult> {
  const now = new Date();

  const freshness = await computeFreshness(now);
  const integrity = await computeIntegrity(now);
  const deployments = await computeDeployments(now);
  const trust_score = computeTrustScore(freshness, integrity, deployments);

  return { trust_score, freshness, integrity, deployments };
}

async function computeFreshness(now: Date): Promise<FreshnessEntry[]> {
  const entries: FreshnessEntry[] = [];

  const qdrantFreshness = await checkQdrantFreshness(now);
  entries.push(qdrantFreshness);

  const railwayFreshness = await checkRailwayFreshness(now);
  entries.push(railwayFreshness);

  const vercelFreshness = await checkVercelFreshness(now);
  entries.push(vercelFreshness);

  const stFreshness = await checkServiceTitanFreshness(now);
  entries.push(stFreshness);

  const xeroFreshness = await checkXeroFreshness(now);
  entries.push(xeroFreshness);

  return entries;
}

async function checkQdrantFreshness(now: Date): Promise<FreshnessEntry> {
  try {
    const res = await fetch("http://localhost:6333/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return {
        source: "Qdrant (task_metrics)",
        last_sync: new Date().toISOString(),
        staleness_minutes: 0,
        acceptable_threshold_minutes: 30,
      };
    }
  } catch {
    const lastSync = process.env.QDRANT_LAST_SYNC;
    if (lastSync) {
      const staleness = Math.floor((now.getTime() - new Date(lastSync).getTime()) / 60000);
      return {
        source: "Qdrant (task_metrics)",
        last_sync: lastSync,
        staleness_minutes: staleness,
        acceptable_threshold_minutes: 30,
      };
    }
  }
  return {
    source: "Qdrant (task_metrics)",
    last_sync: null,
    staleness_minutes: 9999,
    acceptable_threshold_minutes: 30,
  };
}

async function checkRailwayFreshness(now: Date): Promise<FreshnessEntry> {
  const lastDeploy = process.env.RAILWAY_LAST_DEPLOY;
  if (lastDeploy) {
    const staleness = Math.floor((now.getTime() - new Date(lastDeploy).getTime()) / 60000);
    return {
      source: "Railway (worker)",
      last_sync: lastDeploy,
      staleness_minutes: staleness,
      acceptable_threshold_minutes: 60,
    };
  }
  return {
    source: "Railway (worker)",
    last_sync: null,
    staleness_minutes: 9999,
    acceptable_threshold_minutes: 60,
  };
}

async function checkVercelFreshness(now: Date): Promise<FreshnessEntry> {
  const lastDeploy = process.env.VERCEL_LAST_DEPLOY;
  if (lastDeploy) {
    const staleness = Math.floor((now.getTime() - new Date(lastDeploy).getTime()) / 60000);
    return {
      source: "Vercel (dashboard)",
      last_sync: lastDeploy,
      staleness_minutes: staleness,
      acceptable_threshold_minutes: 60,
    };
  }
  return {
    source: "Vercel (dashboard)",
    last_sync: null,
    staleness_minutes: 9999,
    acceptable_threshold_minutes: 60,
  };
}

async function checkServiceTitanFreshness(now: Date): Promise<FreshnessEntry> {
  const lastSync = process.env.ST_LAST_SYNC;
  if (lastSync) {
    const staleness = Math.floor((now.getTime() - new Date(lastSync).getTime()) / 60000);
    return {
      source: "ServiceTitan (sync)",
      last_sync: lastSync,
      staleness_minutes: staleness,
      acceptable_threshold_minutes: 30,
    };
  }
  return {
    source: "ServiceTitan (sync)",
    last_sync: null,
    staleness_minutes: 9999,
    acceptable_threshold_minutes: 30,
  };
}

async function checkXeroFreshness(now: Date): Promise<FreshnessEntry> {
  const lastSync = process.env.XERO_LAST_SYNC;
  if (lastSync) {
    const staleness = Math.floor((now.getTime() - new Date(lastSync).getTime()) / 60000);
    return {
      source: "Xero (sync)",
      last_sync: lastSync,
      staleness_minutes: staleness,
      acceptable_threshold_minutes: 30,
    };
  }
  return {
    source: "Xero (sync)",
    last_sync: null,
    staleness_minutes: 9999,
    acceptable_threshold_minutes: 30,
  };
}

async function computeIntegrity(now: Date): Promise<IntegrityEntry> {
  const lastRecon = process.env.LAST_INTEGRITY_RECON;
  let score: number | null = null;
  let mismatches = 0;

  if (lastRecon) {
    const reconAge = Math.floor((now.getTime() - new Date(lastRecon).getTime()) / 60000);
    score = Math.max(0, Math.min(100, 100 - reconAge));
  }

  const sourceDataCount = parseInt(process.env.SOURCE_DATA_COUNT || "0", 10);
  const dashboardCount = parseInt(process.env.DASHBOARD_COUNT || "0", 10);

  return {
    score,
    mismatches,
    last_recon: lastRecon || null,
    source_data_count: sourceDataCount,
    dashboard_count: dashboardCount,
  };
}

async function computeDeployments(now: Date): Promise<DeploymentsEntry> {
  const railwayLastDeploy = process.env.RAILWAY_LAST_DEPLOY || null;
  const vercelLastDeploy = process.env.VERCEL_LAST_DEPLOY || null;

  let railwayWorkerStatus = "unknown";
  try {
    const res = await fetch("https://railway.app/health", {
      signal: AbortSignal.timeout(5000),
    });
    railwayWorkerStatus = res.ok ? "operational" : "degraded";
  } catch {
    railwayWorkerStatus = "unreachable";
  }

  let vercelDeployStatus = "unknown";
  try {
    const res = await fetch("https://vercel.com/docs/rest-api", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    vercelDeployStatus = res.ok || res.status === 401 || res.status === 403
      ? "operational"
      : "degraded";
  } catch {
    vercelDeployStatus = "unreachable";
  }

  return {
    railway_last_deploy: railwayLastDeploy,
    vercel_last_deploy: vercelLastDeploy,
    railway_worker_status: railwayWorkerStatus,
    vercel_deploy_status: vercelDeployStatus,
  };
}

function computeTrustScore(
  freshness: FreshnessEntry[],
  integrity: IntegrityEntry,
  deployments: DeploymentsEntry,
): number {
  let freshnessScore = 100;
  for (const entry of freshness) {
    if (entry.staleness_minutes > entry.acceptable_threshold_minutes) {
      const excess = entry.staleness_minutes - entry.acceptable_threshold_minutes;
      freshnessScore -= Math.min(25, excess / 60 * 10);
    }
    if (entry.last_sync === null) {
      freshnessScore -= 15;
    }
  }
  freshnessScore = Math.max(0, Math.min(100, freshnessScore));

  const integrityScore = integrity.score ?? 50;

  let deployScore = 100;
  if (deployments.railway_worker_status !== "operational") deployScore -= 20;
  if (deployments.vercel_deploy_status !== "operational") deployScore -= 20;

  const now = new Date();
  if (deployments.railway_last_deploy) {
    const age = (now.getTime() - new Date(deployments.railway_last_deploy).getTime()) / 60000;
    if (age > 1440) deployScore -= 20;
    else if (age > 720) deployScore -= 10;
  }
  if (deployments.vercel_last_deploy) {
    const age = (now.getTime() - new Date(deployments.vercel_last_deploy).getTime()) / 60000;
    if (age > 1440) deployScore -= 20;
    else if (age > 720) deployScore -= 10;
  }
  deployScore = Math.max(0, Math.min(100, deployScore));

  const trustScore = Math.round(
    freshnessScore * 0.40 +
    integrityScore * 0.35 +
    deployScore * 0.25
  );

  return Math.max(0, Math.min(100, trustScore));
}
