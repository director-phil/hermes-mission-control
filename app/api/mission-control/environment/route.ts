import { execFileSync } from "node:child_process";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const timestamp = new Date().toISOString();
  const environment = process.env.NODE_ENV ?? "development";
  const explicitTarget = process.env.MC_DEPLOYMENT_TARGET;
  const isVercel = Boolean(process.env.VERCEL) || Boolean(process.env.VERCEL_ENV);
  const deploymentTarget = explicitTarget ?? (isVercel ? "vercel" : "local/standalone");

  if (isVercel) {
    const owner = process.env.VERCEL_GIT_REPO_OWNER ?? null;
    const slug = process.env.VERCEL_GIT_REPO_SLUG ?? null;
    const expectedOwner = process.env.MC_EXPECTED_REPO_OWNER ?? "director-phil";
    const expectedSlug = process.env.MC_EXPECTED_REPO_SLUG ?? "hermes-mission-control";
    const repoObserved = Boolean(owner && slug);
    const repoAllowlisted = repoObserved && owner === expectedOwner && slug === expectedSlug;
    return NextResponse.json({
      repo_path: slug ? `vercel://${owner ?? "unknown"}/${slug}` : "vercel://unknown",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      remote: owner && slug ? `https://github.com/${owner}/${slug}.git` : null,
      commit_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      environment,
      deployment_target: deploymentTarget,
      allowlist_status: repoAllowlisted ? "allowlisted" : "blocked",
      source: "vercel-git-metadata",
      error: repoObserved ? undefined : "Vercel Git metadata unavailable",
      timestamp,
    });
  }

  const cwd = process.cwd();
  const allowedRepo = process.env.MC_ALLOWED_REPO ?? "";
  try {
    const git = (...args: string[]) => execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    }).trim();
    return NextResponse.json({
      repo_path: cwd,
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      remote: git("remote", "get-url", "origin"),
      commit_sha: git("rev-parse", "HEAD"),
      environment,
      deployment_target: deploymentTarget,
      allowlist_status: allowedRepo && cwd === allowedRepo ? "allowlisted" : "blocked",
      source: "local-git",
      timestamp,
    });
  } catch {
    return NextResponse.json({
      repo_path: cwd,
      branch: null,
      remote: null,
      commit_sha: null,
      environment,
      deployment_target: deploymentTarget,
      allowlist_status: "blocked",
      source: "local-git",
      error: "Git metadata unavailable",
      timestamp,
    });
  }
}
