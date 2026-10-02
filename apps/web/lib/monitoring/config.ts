import { ProbeDefinition } from "./types";

/**
 * Declarative probe registry. Adding a monitor is a config edit, not code.
 * Internal probes hit loopback/local endpoints and are only meaningful when the
 * engine runs on the box. External probes target the public RT/Supabase plane.
 */

export const MONITORING_DB_PATH =
  process.env.MONITORING_DB_PATH ??
  "/home/phillip_downs/.hermes/mission-control/monitoring.db";

const SUPABASE_REF =
  process.env.SUPABASE_PROJECT_REF ?? "erakxiolnoigptfemedv";

export const probes: ProbeDefinition[] = [
  // ── internal ──────────────────────────────────────────────────────────
  {
    id: "gb10-seat-1",
    name: "GB10 #1 model seat",
    kind: "loopback-http",
    target: "http://gb10-box-1:1234/v1/models",
    cadenceSeconds: 30,
    group: "internal",
  },
  {
    id: "gb10-seat-2",
    name: "GB10 #2 model seat",
    kind: "loopback-http",
    target: "http://gb10-box-2:1234/v1/models",
    cadenceSeconds: 30,
    group: "internal",
  },
  {
    id: "hermes-admission",
    name: "Hermes admission gateway",
    kind: "loopback-http",
    target: "http://127.0.0.1:19875/healthz",
    cadenceSeconds: 30,
    group: "internal",
  },
  {
    id: "qdrant",
    name: "Qdrant vector DB",
    kind: "loopback-http",
    target: "http://127.0.0.1:6333/collections",
    cadenceSeconds: 30,
    group: "internal",
  },
  {
    id: "goal-conveyor",
    name: "Goal conveyor",
    kind: "local-file",
    target: "/home/phillip_downs/ChatDev/goals/state/queue-runner-status.json",
    cadenceSeconds: 30,
    group: "internal",
    degradeTo: "degraded",
  },

  // ── external ──────────────────────────────────────────────────────────
  {
    id: "rt-dashboard",
    name: "RT dashboard",
    kind: "http",
    target: "https://dashboards.reliabletradies.app/",
    cadenceSeconds: 60,
    group: "external",
  },
  {
    id: "rt-login",
    name: "RT login",
    kind: "http",
    target: "https://login.reliabletradies.app/",
    cadenceSeconds: 60,
    group: "external",
  },
  {
    id: "supabase-rest",
    name: "Supabase REST",
    kind: "http",
    target: `https://${SUPABASE_REF}.supabase.co/rest/v1/`,
    cadenceSeconds: 60,
    group: "external",
  },
  {
    id: "rt-dashboard-ssl",
    name: "RT dashboard SSL",
    kind: "ssl",
    target: "dashboards.reliabletradies.app",
    cadenceSeconds: 21600,
    group: "external",
    degradeTo: "degraded",
  },
];
