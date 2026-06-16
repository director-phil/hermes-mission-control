/**
 * S7 — Event Audit foundation layer.
 *
 * In-memory audit event store with filtering, counting, and authenticated
 * mutation. This is the foundation layer that S10 Watchdog Agents depends on.
 *
 * Events persist in-process (per Next.js server instance). On production
 * deployment this would be backed by a database table.
 */

/* ── Types ─────────────────────────────────────────────────────────── */

export interface AuditEvent {
  id: string;
  type: EventType;
  severity: EventSeverity;
  source: string;
  message: string;
  timestamp: string;
  status: EventStatus;
  related_task_id?: string;
}

export type EventType =
  | "system_health"
  | "agent_activity"
  | "data_sync"
  | "deployment"
  | "security"
  | "error"
  | "warning"
  | "info";

export type EventSeverity = "critical" | "high" | "medium" | "low" | "info";

export type EventStatus = "active" | "acknowledged" | "resolved" | "suppressed";

export interface EventQueryParams {
  type?: EventType;
  severity?: EventSeverity;
  status?: EventStatus;
}

export interface EventListResponse {
  events: AuditEvent[];
  total_count: number;
  filtered_count: number;
}

/* ── In-memory store ───────────────────────────────────────────────── */

let events: AuditEvent[] = [];
let nextId = 1;

function generateId(): string {
  return `evt_${String(nextId++).padStart(6, "0")}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

/* ── Public API ────────────────────────────────────────────────────── */

/**
 * Query events with optional filters.
 * Returns events sorted newest-first.
 */
export function getEvents(params?: EventQueryParams): EventListResponse {
  const total_count = events.length;

  let filtered = events;
  if (params) {
    if (params.type) {
      filtered = filtered.filter((e) => e.type === params.type);
    }
    if (params.severity) {
      filtered = filtered.filter((e) => e.severity === params.severity);
    }
    if (params.status) {
      filtered = filtered.filter((e) => e.status === params.status);
    }
  }

  // Sort newest first
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return {
    events: sorted,
    total_count,
    filtered_count: sorted.length,
  };
}

/**
 * Create an audit event. Returns the created event.
 * Callers must validate auth before invoking this.
 */
export function createEvent(
  input: Omit<AuditEvent, "id" | "timestamp">
): AuditEvent {
  const event: AuditEvent = {
    ...input,
    id: generateId(),
    timestamp: nowISO(),
  };
  events.push(event);

  // Keep only the last 1000 events in memory
  if (events.length > 1000) {
    events = events.slice(events.length - 1000);
  }

  return event;
}

/**
 * Seed the store with initial events for development/testing.
 * Called once at startup.
 */
export function seedInitialEvents(): void {
  if (events.length > 0) return; // Already seeded

  const seedEvents: Omit<AuditEvent, "id" | "timestamp">[] = [
    {
      type: "info",
      severity: "info",
      source: "system",
      message: "Mission Control initialized",
      status: "resolved",
    },
    {
      type: "system_health",
      severity: "low",
      source: "health-check",
      message: "All systems operational",
      status: "active",
    },
    {
      type: "data_sync",
      severity: "medium",
      source: "qdrant-sync",
      message: "Task metrics synced successfully",
      status: "resolved",
    },
    {
      type: "deployment",
      severity: "low",
      source: "railway",
      message: "Production deployment completed",
      status: "resolved",
    },
    {
      type: "security",
      severity: "high",
      source: "auth",
      message: "Rate limit triggered on /api/auth",
      status: "acknowledged",
      related_task_id: "t_security_001",
    },
  ];

  for (const se of seedEvents) {
    createEvent(se);
  }
}

/**
 * Get event counts by severity for dashboard display.
 */
export function getEventCounts(): Record<EventSeverity, number> {
  const counts: Record<EventSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const e of events) {
    if (e.status === "active") {
      counts[e.severity] = (counts[e.severity] || 0) + 1;
    }
  }
  return counts;
}
