import type { RuntimeEvent, RuntimeEventType } from "./runtime-events";

export type EventSeverity = "critical" | "high" | "medium" | "low" | "info";
export type EventStatus = "active" | "resolved";

export interface AuditEvent {
  id: string;
  type: RuntimeEventType;
  severity: EventSeverity;
  source: string;
  message: string;
  timestamp: string;
  status: EventStatus;
  related_task_id?: string;
}

export interface EventListResponse {
  events: AuditEvent[];
  total_count: number;
  filtered_count: number;
}

export function runtimeToAuditEvents(events: readonly RuntimeEvent[]): EventListResponse {
  const mapped = events.map((event): AuditEvent => ({
    id: event.id,
    type: event.type,
    severity: event.severity === "critical" ? "critical" : event.severity === "warning" ? "medium" : "info",
    source: event.source,
    message: event.summary,
    timestamp: event.timestamp,
    status: event.severity === "info" ? "resolved" : "active",
    related_task_id: event.goal_id,
  })).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  return {
    events: mapped,
    total_count: mapped.length,
    filtered_count: mapped.length,
  };
}
