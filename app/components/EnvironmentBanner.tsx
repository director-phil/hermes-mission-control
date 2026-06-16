/**
 * S0 — Environment Banner
 *
 * Persistent banner showing the active repo, branch, SHA, and allowlist
 * status. Displays a red blocked state when the guardrail fails.
 */

"use client";

import { useEffect, useState } from "react";

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

  useEffect(() => {
    fetch("/api/mission-control/environment")
      .then((r) => r.json())
      .then((data) => {
        setEnv(data);
        setLoading(false);
      })
      .catch(() => {
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
      });
  }, []);

  if (loading) {
    return (
      <div className="bg-amber-950/50 border-b border-amber-800/30 px-4 py-2 text-xs text-amber-300 font-mono">
        <span className="inline-block w-2 h-2 bg-amber-500 rounded-full animate-pulse mr-2" />
        Loading environment…
      </div>
    );
  }

  const isBlocked = env?.allowlist_status === "blocked";

  return (
    <div
      className={`
        border-b px-4 py-2 flex items-center justify-between text-xs font-mono
        ${isBlocked
          ? "bg-red-950/60 border-red-800/40 text-red-300"
          : "bg-slate-900/80 border-slate-800/40 text-slate-400"
        }
      `}
    >
      <div className="flex items-center gap-4">
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
        <div className="flex items-center gap-1.5">
          <span className="text-slate-600">repo:</span>
          <span className="truncate max-w-[300px] text-slate-300">
            {env?.repo_path ?? "unknown"}
          </span>
        </div>

        {/* Branch */}
        {env?.branch && (
          <div className="flex items-center gap-1.5">
            <span className="text-slate-600">branch:</span>
            <span className="text-blue-400">{env.branch}</span>
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
      <div className="text-slate-600">
        → {env?.deployment_target ?? "unknown"}
      </div>
    </div>
  );
}
