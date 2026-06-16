/**
 * S0 — Repo and Environment Guardrail
 *
 * Reads git metadata from the working directory and validates against the
 * allowlist. Returns the result so the UI can show the environment banner.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { execSync } = require("child_process");
    const cwd = process.cwd();
    
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd }).toString().trim();
    const remote = execSync("git remote get-url origin", { cwd }).toString().trim();
    const sha = execSync("git rev-parse HEAD", { cwd }).toString().trim();
    const env = process.env.NODE_ENV ?? "development";
    const allowedRepo = process.env.MC_ALLOWED_REPO ?? "";

    const isAllowlisted =
      allowedRepo && cwd === allowedRepo ? "allowlisted" : "blocked";

    return NextResponse.json({
      repo_path: cwd,
      branch,
      remote,
      commit_sha: sha,
      environment: env,
      deployment_target: "railway",
      allowlist_status: isAllowlisted,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({
      repo_path: process.cwd(),
      branch: null,
      remote: null,
      commit_sha: null,
      environment: process.env.NODE_ENV ?? "development",
      deployment_target: "railway",
      allowlist_status: "blocked",
      error: "Git metadata unavailable",
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
