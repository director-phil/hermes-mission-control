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
  {
    id: "checkcle",
    name: "CheckCle monitor",
    kind: "loopback-http",
    target: "http://127.0.0.1:8091/",
    url: "https://gb10-coder.taile151d3.ts.net:8091",
    cadenceSeconds: 60,
    group: "internal",
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
  {
    id: "rt-login-ssl",
    name: "RT login SSL",
    kind: "ssl",
    target: "login.reliabletradies.app",
    cadenceSeconds: 21600,
    group: "external",
    degradeTo: "degraded",
  },

  // ── RT app services (reachability) ────────────────────────────────────
  {
    id: "rt-api-health",
    name: "RT API health",
    kind: "http",
    target: "https://dashboards.reliabletradies.app/api/health",
    cadenceSeconds: 60,
    group: "external",
  },
  {
    id: "supabase-auth",
    name: "Supabase auth",
    kind: "http",
    target: `https://${SUPABASE_REF}.supabase.co/auth/v1/health`,
    cadenceSeconds: 60,
    group: "external",
  },
  {
    id: "servicetitan-api",
    name: "ServiceTitan API",
    kind: "http",
    target: "https://api.servicetitan.io/",
    cadenceSeconds: 300,
    group: "external",
  },
  {
    id: "xero-api",
    name: "Xero API",
    kind: "http",
    target: "https://api.xero.com/",
    cadenceSeconds: 300,
    group: "external",
  },

  // ── Vercel ────────────────────────────────────────────────────────────
  {
    id: "vercel-platform",
    name: "Vercel platform",
    kind: "http",
    target: "https://www.vercel-status.com/api/v2/status.json",
    cadenceSeconds: 300,
    group: "external",
  },
  {
    id: "vercel-deploy",
    name: "Vercel latest deploy",
    kind: "vercel-deploy",
    target: "reliable-tradies-ops-v2",
    cadenceSeconds: 300,
    group: "external",
  },

  // ── host metrics ──────────────────────────────────────────────────────
  {
    id: "hermes-host",
    name: "Hermes host",
    kind: "server",
    target: "local",
    cadenceSeconds: 60,
    group: "internal",
  },
];
