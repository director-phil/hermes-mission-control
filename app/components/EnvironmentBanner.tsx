/**
 * S0 — Environment Banner
 *
 * Persistent banner showing the active repo, branch, SHA, and allowlist
 * status. Displays a red blocked state when the guardrail fails.
 */

"use client";

import { useEffect, useRef, useState } from "react";

interface EnvData {
  repo_path: string | null;
  branch: string | null;
  remote: string | null;
  commit_sha: string | null;
  environment: string;
  deployment_target: string;
  allowlist_status: string;
  error?: string;
  timestamp: string;
}

export default function EnvironmentBanner() {
  const [env, setEnv] = useState<EnvData | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function loadEnvironment() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch("/api/mission-control/environment", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Environment API ${response.status}`);
        const data = (await response.json()) as EnvData;
        if (!cancelled) {
          setEnv(data);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setEnv({
            repo_path: null,
            branch: null,
            remote: null,
            commit_sha: null,
            environment: "unknown",
            deployment_target: "unknown",
            allowlist_status: "blocked",
            error: "Failed to read environment",
            timestamp: new Date().toISOString(),
          });
          setLoading(false);
        }
      } finally {
        inFlight.current = false;
      }
    }

    loadEnvironment();
    const interval = window.setInterval(loadEnvironment, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="mc-env-banner">
        <span className="inline-block w-2 h-2 bg-amber-500 rounded-full animate-pulse mr-2" />
        Loading environment…
      </div>
    );
  }

  const isBlocked = env?.allowlist_status === "blocked";

  return (
    <div className={`mc-env-banner ${isBlocked ? "is-blocked" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {/* Status indicator */}
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isBlocked ? "bg-red-500 animate-pulse" : "bg-emerald-500"
            }`}
          />
          <span className="uppercase tracking-wider font-bold">
            {isBlocked ? "BLOCKED" : "ALLOWED"}
          </span>
        </div>

        {/* Repo path */}
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          <span className="text-slate-600">repo:</span>
          <span className="min-w-0 max-w-full truncate text-slate-300 sm:max-w-[300px]">
            {env?.repo_path ?? "unknown"}
          </span>
        </div>

        {/* Branch */}
        {env?.branch && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-slate-600">branch:</span>
            <span className="min-w-0 break-all text-blue-400 sm:break-normal">{env.branch}</span>
          </div>
        )}

        {/* SHA */}
        {env?.commit_sha && (
          <div className="flex items-center gap-1.5">
            <span className="text-slate-600">sha:</span>
            <span className="text-slate-500">{env.commit_sha.slice(0, 8)}</span>
          </div>
        )}

        {/* Environment */}
        <div className="flex items-center gap-1.5">
          <span className="text-slate-600">env:</span>
          <span className="text-slate-500">{env?.environment ?? "unknown"}</span>
        </div>
      </div>

      {/* Deployment target */}
      <div className="mc-env-target">
        <span>target: {env?.deployment_target ?? "unknown"}</span>
        <span>source: {env?.timestamp ?? "unknown timestamp"}</span>
      </div>
    </div>
  );
}
