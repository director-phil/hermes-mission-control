/**
 * Shared types for the Mission Control native monitoring subsystem.
 * Used by both the standalone probe engine (tsx) and the Next.js read route.
 */

export type ProbeStatus = "up" | "degraded" | "down";

export type ProbeKind =
  | "http" // HTTP/HTTPS reachability (any response < 500 counts as up)
  | "tcp" // raw TCP connect
  | "dns" // DNS resolve
  | "ssl" // TLS cert issuer/expiry
  | "local-file" // read a local status file
  | "loopback-http" // HTTP against a loopback/localhost endpoint
  | "server" // host metrics: CPU load, RAM, disk, network (local box)
  | "vercel-deploy"; // Vercel latest-deployment state (token-authenticated)

export type ProbeGroup = "internal" | "external";

export interface ProbeDefinition {
  id: string; // stable id, used as incident key
  name: string; // human label
  kind: ProbeKind;
  target: string; // URL / host:port / hostname / absolute path
  /** Optional user-facing URL (e.g. Tailscale hostname) for click-through from the board. */
  url?: string;
  cadenceSeconds: number;
  timeoutMs?: number;
  group: ProbeGroup;
  /** When a probe degrades (e.g. SSL close to expiry), treat as down or degraded. */
  degradeTo?: "down" | "degraded";
}

export interface ProbeResultRow {
  id: number;
  probe_id: string;
  ts: string; // ISO
  status: ProbeStatus;
  latency_ms: number | null;
  http_status: number | null;
  metric: string | null;
  error: string | null;
}

export type IncidentState = "open" | "resolved";

export interface IncidentRow {
  id: number;
  probe_id: string;
  probe_name: string;
  opened_ts: string;
  resolved_ts: string | null;
  state: IncidentState;
  last_status: ProbeStatus;
  last_error: string | null;
}

export interface MaintenanceRow {
  id: number;
  probe_id: string;
  note: string | null;
  created_ts: string;
  active: number;
}

export interface ServiceStatus {
  probe: ProbeDefinition;
  latest: ProbeResultRow | null;
  uptimePct24h: number | null;
  incident: IncidentRow | null;
  maintenance: MaintenanceRow | null;
}

export type GlobalStatus = "healthy" | "warning" | "critical";

export interface MonitoringSnapshot {
  generated_ts: string;
  global_status: GlobalStatus;
  services: ServiceStatus[];
  open_incidents: IncidentRow[];
  total: number;
  up: number;
  degraded: number;
  down: number;
}
