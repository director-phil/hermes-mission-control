/**
 * S6 — Production Trust API
 *
 * GET  /api/mission-control/production-trust  — Compute trust score
 */

import { NextResponse } from "next/server";
import { computeProductionTrust } from "@/lib/production-trust";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await computeProductionTrust();
  return NextResponse.json(result);
}
