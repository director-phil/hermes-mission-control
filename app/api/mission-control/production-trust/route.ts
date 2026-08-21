import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    timestamp: new Date().toISOString(),
    trust_score: null,
    status: "unknown",
    evidence_status: "unverified",
    reason: "No source-backed freshness, reconciliation, and deployment adapter is configured; no numeric trust score is asserted.",
    freshness: [
      "Qdrant task metrics",
      "Vercel deployment",
      "ServiceTitan sync",
      "Xero sync",
    ].map((source) => ({
      source,
      last_sync: null,
      staleness_minutes: null,
      acceptable_threshold_minutes: null,
      status: "unknown",
    })),
    integrity: {
      score: null,
      mismatches: null,
      last_recon: null,
      source_data_count: null,
      dashboard_count: null,
      status: "unknown",
    },
    deployments: {
      vercel_last_deploy: null,
      vercel_deploy_status: "unknown",
      status: "unknown",
    },
  });
}
