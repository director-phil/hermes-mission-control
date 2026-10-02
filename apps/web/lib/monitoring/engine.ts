/**
 * Monitoring probe engine — a long-running background process (run via `tsx`),
 * mirroring the existing `hermes_native_goal_runner` systemd pattern.
 *
 *   tsx apps/web/lib/monitoring/engine.ts            # run forever (systemd)
 *   tsx apps/web/lib/monitoring/engine.ts --once     # one sweep, print snapshot, exit
 */

import { MONITORING_DB_PATH, probes } from "./config";
import {
  buildSnapshot,
  getLatest,
  getOpenIncident,
  insertResult,
  openDb,
  openIncident,
  prune,
  resolveIncident,
} from "./store";
import { runProbe } from "./probes";
import { postToSlack } from "./notify";
import { DatabaseSync } from "node:sqlite";
import { ProbeDefinition, ProbeStatus } from "./types";

const TICK_MS = 5000;

function isUnhealthy(status: ProbeStatus): boolean {
  return status === "down" || status === "degraded";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processProbe(db: DatabaseSync, probe: ProbeDefinition): Promise<void> {
  const previous = getLatest(db, probe.id);
  const outcome = await runProbe(probe);
  insertResult(db, probe.id, outcome);

  const prevStatus = previous?.status ?? null;
  const open = getOpenIncident(db, probe.id);

  if (isUnhealthy(outcome.status) && !open && prevStatus !== null) {
    openIncident(db, probe.id, probe.name, outcome.status, outcome.error);
    const detail = outcome.error ?? outcome.metric ?? "";
    await postToSlack(`🚨 *${probe.name}* is *${outcome.status}*\n${detail}`);
    console.log(`[monitor] incident opened: ${probe.id} -> ${outcome.status}`);
  } else if (outcome.status === "up" && open) {
    resolveIncident(db, probe.id);
    await postToSlack(`✅ *${probe.name}* recovered`);
    console.log(`[monitor] incident resolved: ${probe.id}`);
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const db = openDb(MONITORING_DB_PATH);
  const lastRun = new Map<string, number>();
  let sweep = 0;

  console.log(
    `[monitor] engine ${once ? "once" : "loop"} · ${probes.length} probes · db=${MONITORING_DB_PATH}`,
  );

  while (true) {
    const now = Date.now();
    const due = probes.filter(
      (p) => now - (lastRun.get(p.id) ?? 0) >= p.cadenceSeconds * 1000,
    );
    for (const probe of due) {
      lastRun.set(probe.id, now);
      await processProbe(db, probe);
    }

    sweep += 1;
    if (sweep % 120 === 0) prune(db);

    if (once) {
      db.close();
      const snapshot = buildSnapshot(probes, MONITORING_DB_PATH);
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    await sleep(TICK_MS);
  }
}

main().catch((err) => {
  console.error("[monitor] fatal", err);
  process.exit(1);
});
