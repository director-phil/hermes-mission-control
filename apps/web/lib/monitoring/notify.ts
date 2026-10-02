/**
 * Slack notification via the existing RT Slack App (`chat.postMessage`).
 * Reuses `SLACK_BOT_TOKEN` + `SLACK_CHANNEL`. Gracefully no-ops when the token
 * or channel is unset so the engine runs standalone without secrets.
 */

export async function postToSlack(text: string): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL ?? process.env.MONITORING_SLACK_CHANNEL;
  if (!token || !channel) {
    return false;
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; error?: string };
    return body.ok === true;
  } catch {
    return false;
  }
}
