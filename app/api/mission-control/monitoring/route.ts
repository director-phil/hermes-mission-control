import { NextResponse } from "next/server";
import { buildSnapshot } from "@/lib/monitoring/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET() {
  const snapshot = buildSnapshot();
  return NextResponse.json(snapshot);
}
