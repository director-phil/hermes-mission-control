/**
 * S0 — Repo and Environment Guardrail
 *
 * Reads git metadata from the working directory and validates against the
 * allowlist. Returns the result so the UI can show the environment banner
 * and block unsafe actions when the repo is wrong.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cwd = process.cwd();
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    const remote = await git("remote", "get-url", "origin");
    const sha = await git("rev-parse", "HEAD");
    const env = process.env.NODE_ENV ?? "development";
    const allowedRepo = process.env.MC_ALLOWED_REPO ?? "";

    const isAllowlisted =
      allowedRepo && cwd === allowedRepo ? "allowlisted" : "blocked";

    return Response.json({
      repo_path: cwd,
      branch,
      remote,
      commit_sha: sha,
      environment: env,
      deployment_target: "local",
      allowlist_status: isAllowlisted,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // If git metadata can't be read, return blocked state
    return Response.json({
      repo_path: process.cwd(),
      branch: null,
      remote: null,
      commit_sha: null,
      environment: process.env.NODE_ENV ?? "development",
      deployment_target: "local",
      allowlist_status: "blocked",
      error: "Git metadata unavailable",
      timestamp: new Date().toISOString(),
    });
  }
}

/* ── helpers ─────────────────────────────────────────────────────── */

function git(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const proc = spawn("git", args, {
      cwd: process.cwd(),
      timeout: 5000,
    });

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code: number) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git ${args.join(" ")} exited with ${code}`));
      }
    });

    proc.on("error", reject);
  });
}
