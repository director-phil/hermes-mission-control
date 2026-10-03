/**
 * SQLite persistence for the monitoring subsystem, backed by Node's built-in
 * `node:sqlite` (no native compile). Shared by the standalone engine and the
 * Next.js read route.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  GlobalStatus,
  IncidentRow,
  MaintenanceRow,
  MonitoringSnapshot,
  ProbeDefinition,
  ProbeResultRow,
  ProbeStatus,
} from "./types";
import { MONITORING_DB_PATH, probes as defaultProbes } from "./config";

const RETENTION_DAYS = 90;

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  createSchema(db);
  return db;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      probe_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      http_status INTEGER,
      metric TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_probe_results_probe_ts ON probe_results (probe_id, ts);

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      probe_id TEXT NOT NULL,
      probe_name TEXT NOT NULL,
      opened_ts TEXT NOT NULL,
      resolved_ts TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      last_status TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_probe_state ON incidents (probe_id, state);

    CREATE TABLE IF NOT EXISTS maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      probe_id TEXT NOT NULL,
      note TEXT,
      created_ts TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_probe ON maintenance (probe_id, active);
  `);
}

/* ── writes ──────────────────────────────────────────────────────────── */

export interface InsertResultInput {
  status: ProbeStatus;
  latency_ms: number | null;
  http_status: number | null;
  metric: string | null;
  error: string | null;
}

export function insertResult(
  db: DatabaseSync,
  probeId: string,
  result: InsertResultInput,
): void {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO probe_results (probe_id, ts, status, latency_ms, http_status, metric, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    probeId,
    ts,
    result.status,
    result.latency_ms,
    result.http_status,
    result.metric,
    result.error,
  );
}

export function getLatest(db: DatabaseSync, probeId: string): ProbeResultRow | null {
  const row = db
    .prepare(
      `SELECT id, probe_id, ts, status, latency_ms, http_status, metric, error
       FROM probe_results WHERE probe_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(probeId) as ProbeResultRow | undefined;
  return row ?? null;
}

/* ── incidents ───────────────────────────────────────────────────────── */

export function getOpenIncident(db: DatabaseSync, probeId: string): IncidentRow | null {
  const row = db
    .prepare(
      `SELECT id, probe_id, probe_name, opened_ts, resolved_ts, state, last_status, last_error
       FROM incidents WHERE probe_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
    )
    .get(probeId) as IncidentRow | undefined;
  return row ?? null;
}

export function openIncident(
  db: DatabaseSync,
  probeId: string,
  probeName: string,
  status: ProbeStatus,
  error: string | null,
): void {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO incidents (probe_id, probe_name, opened_ts, state, last_status, last_error)
     VALUES (?, ?, ?, 'open', ?, ?)`,
  ).run(probeId, probeName, ts, status, error);
}

export function resolveIncident(db: DatabaseSync, probeId: string): void {
  const ts = new Date().toISOString();
  db.prepare(
    `UPDATE incidents SET state = 'resolved', resolved_ts = ? WHERE probe_id = ? AND state = 'open'`,
  ).run(ts, probeId);
}

/* ── reads / snapshot ────────────────────────────────────────────────── */

export function uptimePct(db: DatabaseSync, probeId: string, windowMs: number): number | null {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status != 'down' THEN 1 ELSE 0 END) AS ok
       FROM probe_results WHERE probe_id = ? AND ts >= ?`,
    )
    .get(probeId, since) as { total: number; ok: number } | undefined;
  if (!row || !row.total) return null;
  return Math.round((row.ok / row.total) * 1000) / 10;
}

export function listOpenIncidents(db: DatabaseSync): IncidentRow[] {
  return db
    .prepare(
      `SELECT id, probe_id, probe_name, opened_ts, resolved_ts, state, last_status, last_error
       FROM incidents WHERE state = 'open' ORDER BY id DESC`,
    )
    .all() as IncidentRow[];
}

/* ── maintenance (pause/resume) ──────────────────────────────────────── */

export function isInMaintenance(db: DatabaseSync, probeId: string): boolean {
  return db.prepare(`SELECT 1 FROM maintenance WHERE probe_id = ? AND active = 1 LIMIT 1`).get(probeId) !== undefined;
}

export function getMaintenance(db: DatabaseSync, probeId: string): MaintenanceRow | null {
  const row = db
    .prepare(
      `SELECT id, probe_id, note, created_ts, active
       FROM maintenance WHERE probe_id = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(probeId) as MaintenanceRow | undefined;
  return row ?? null;
}

export function setMaintenance(db: DatabaseSync, probeId: string, active: boolean, note: string | null): void {
  const ts = new Date().toISOString();
  db.prepare(`UPDATE maintenance SET active = 0 WHERE probe_id = ? AND active = 1`).run(probeId);
  if (active) {
    db.prepare(`INSERT INTO maintenance (probe_id, note, created_ts, active) VALUES (?, ?, ?, 1)`).run(probeId, note, ts);
  }
}

export function buildSnapshot(
  probeList: ProbeDefinition[] = defaultProbes,
  dbPath: string = MONITORING_DB_PATH,
): MonitoringSnapshot {
  const db = openDb(dbPath);
  try {
    const services = probeList.map((probe) => {
      const latest = getLatest(db, probe.id);
      return {
        probe,
        latest,
        uptimePct24h: uptimePct(db, probe.id, 24 * 60 * 60 * 1000),
        incident: getOpenIncident(db, probe.id),
        maintenance: getMaintenance(db, probe.id),
      };
    });

    const openIncidents = listOpenIncidents(db);
    const active = services.filter((s) => !s.maintenance);
    const up = active.filter((s) => s.latest?.status === "up").length;
    const degraded = active.filter((s) => s.latest?.status === "degraded").length;
    const down = active.filter((s) => s.latest?.status === "down").length;

    let globalStatus: GlobalStatus = "healthy";
    if (down > 0) globalStatus = "critical";
    else if (degraded > 0 || active.some((s) => !s.latest)) globalStatus = "warning";

    return {
      generated_ts: new Date().toISOString(),
      global_status: globalStatus,
      services,
      open_incidents: openIncidents,
      total: services.length,
      up,
      degraded,
      down,
    };
  } finally {
    db.close();
  }
}

export function prune(db: DatabaseSync, retentionDays = RETENTION_DAYS): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM probe_results WHERE ts < ?`).run(cutoff);
}
