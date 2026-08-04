import { NextResponse } from "next/server";
import { buildRuntimeSnapshot } from "@/lib/runtime-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await buildRuntimeSnapshot());
}
