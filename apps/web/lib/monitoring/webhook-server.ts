/**
 * Langfuse webhook receiver — accepts monitor-alert webhooks POSTed by the
 * Langfuse container (over the docker bridge) and forwards a formatted message
 * to Slack via the existing RT Slack bot (`notify.ts` → `chat.postMessage`).
 *
 * Run as a user systemd service; Slack creds come from the shared env file.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { postToSlack } from "./notify";

const PORT = Number(process.env.LANG_FUSE_WEBHOOK_PORT ?? 3931);
const HOST = process.env.LANG_FUSE_WEBHOOK_HOST ?? "0.0.0.0";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatAlert(body: Record<string, unknown>): string {
  const isCheckCle =
    "service_name" in body || "serviceName" in body || "service" in body ||
    "host" in body || "service_type" in body;
  const monitor =
    body.monitorName ?? body.monitor ?? body.monitor_name ?? body.name ??
    body.service_name ?? body.serviceName ?? body.service ?? "Alert";
  const status = body.status ?? "";
  const type = body.alertType ?? body.type ?? body.event ?? body.service_type ?? "";
  const message = body.message ?? body.text ?? body.alert ?? body.error_message ?? "";
  const project = body.projectName ?? body.project ?? body.projectId ?? "";
  const url = body.url ?? body.link ?? body.alertUrl ?? body.host ?? "";

  const head = isCheckCle ? `🔔 *${str(monitor)}*` : `🚨 *Langfuse: ${str(monitor)}*`;
  const parts: string[] = [head];
  if (status) parts.push(`*Status:* ${str(status)}`);
  if (type) parts.push(`*Type:* ${str(type)}`);
  if (project) parts.push(`*Project:* ${str(project)}`);
  if (message) parts.push(str(message));
  if (url) parts.push(str(url));

  // If nothing recognizable was extracted, fall back to a raw dump so alerts
  // are never silently empty.
  if (parts.length <= 1) {
    parts.push("```" + JSON.stringify(body, null, 2).slice(0, 2000) + "```");
  }
  return parts.join("\n");
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  try {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const text = formatAlert(body);
    const ok = await postToSlack(text);
    res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, slack: ok }));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[langfuse-webhook] listening on ${HOST}:${PORT}`);
});
