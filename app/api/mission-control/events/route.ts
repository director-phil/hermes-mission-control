/**
 * S7 — Event Audit API
 *
 * GET  /api/mission-control/events  — List events with filtering
 * POST /api/mission-control/events  — Create an audit event (auth required)
 */

import { NextRequest, NextResponse } from "next/server";
import { getEvents, createEvent, seedInitialEvents, AuditEvent } from "@/lib/event-audit";

export const dynamic = "force-dynamic";

/* ── Seed on first import ─────────────────────────────────────────── */

seedInitialEvents();

/* ── Auth helper ───────────────────────────────────────────────────── */

function verifyAuth(req: NextRequest): { ok: boolean; error: string } {
  const cronSecret = process.env.CRON_SECRET;
  const adminAuth = req.headers.get("x-admin-auth");

  if (cronSecret && req.headers.get("authorization") === `Bearer ${cronSecret}`) {
    return { ok: true, error: "" };
  }

  if (adminAuth) {
    return { ok: true, error: "" };
  }

  return {
    ok: false,
    error: "Unauthorized: POST requires CRON_SECRET or x-admin-auth header",
  };
}

/* ── GET ───────────────────────────────────────────────────────────── */

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const type = searchParams.get("type");
  const severity = searchParams.get("severity");
  const status = searchParams.get("status");

  const params: { type?: string; severity?: string; status?: string } = {};
  if (type) params.type = type;
  if (severity) params.severity = severity;
  if (status) params.status = status;

  const result =
    Object.keys(params).length > 0
      ? getEvents(params as any)
      : getEvents();

  return NextResponse.json(result);
}

/* ── POST ──────────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const auth = verifyAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await req.json();

    const allowedFields = [
      "type",
      "severity",
      "source",
      "message",
      "status",
      "related_task_id",
    ] as const;

    const parsed: Record<string, unknown> = {};
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        parsed[key] = body[key];
      }
    }

    // Validate required fields
    const type = parsed.type as string;
    const severity = parsed.severity as string;
    const source = parsed.source as string;
    const message = parsed.message as string;
    const status = parsed.status as string | undefined;
    const relatedTaskId = parsed.related_task_id as string | undefined;

    if (!type || !severity || !source || !message) {
      return NextResponse.json(
        {
          error: "Missing required fields: type, severity, source, message",
        },
        { status: 400 }
      );
    }

    // Validate enum values
    const validTypes: string[] = [
      "system_health",
      "agent_activity",
      "data_sync",
      "deployment",
      "security",
      "error",
      "warning",
      "info",
    ];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: `Invalid type. Must be one of: ${validTypes.join(", ")}` },
        { status: 400 }
      );
    }

    const validSeverities: string[] = ["critical", "high", "medium", "low", "info"];
    if (!validSeverities.includes(severity)) {
      return NextResponse.json(
        { error: `Invalid severity. Must be one of: ${validSeverities.join(", ")}` },
        { status: 400 }
      );
    }

    const validStatuses: string[] = ["active", "acknowledged", "resolved", "suppressed"];
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const event = createEvent({
      type,
      severity,
      source,
      message,
      status: status || "active",
      related_task_id: relatedTaskId,
    } as Omit<AuditEvent, "id" | "timestamp">);

    return NextResponse.json(event, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}
