#!/usr/bin/env python3
"""
Deterministic local review gate — OpenCodeReview-inspired.

Implements the three-stage pipeline the 2026 review research converged on:

  1. RULE-GUIDED DISPATCH   — deterministic path/pattern rules map changed files
                              to review criteria. No agent-driven file triage.
  2. GROUNDED REVIEW        — the diff + only the dispatched criteria go to the
                              local reviewer model, with a structured
                              "map the change → trace dependents → validate
                              against callers/tests" prompt.
  3. INDEPENDENT REFLECTION — a falsification-first filter under an asymmetric
                              information boundary: the reflector sees ONLY the
                              diff + the reviewer's findings (never the repo
                              context the reviewer gathered), and removes any
                              finding not directly supported by the diff text.

Reviewer output is EVIDENCE, not verdict: every surviving finding must still be
verified against the real code before it is fixed. This tool surfaces findings;
it does not mutate anything.

Model endpoint defaults to the documented working local reviewer combo
(`qwen3-coder-next` @ `http://gb10-reviewer:1234/v1`, no auth). Override with
--endpoint / --model. The admission-gateway alias (`local-reviewer`) is NOT the
default because it 504s on large full-diff prompts.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# Deterministic rule dispatch
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Rule:
    id: str
    title: str
    checks: tuple[str, ...]


# Each rule's checks are phrased as concrete, verifiable review criteria. Keep
# them specific — the research shows review quality follows structure, not model
# choice, and vague criteria produce confident fabrications.
RULES: tuple[Rule, ...] = (
    Rule(
        id="calc",
        title="Canonical calculation / read-model (V2 Law §1)",
        checks=(
            "No business math in page.tsx / components — all calculations in lib/calculations or a typed server route.",
            "Exactly one canonical definition per rule — no duplicated or re-derived formula.",
            "No mart_/fact_/dim_ reads, no Railway reads, no DATABASE_URL query(), no raw SQL in a page.",
            "No hardcoded rates/constants scattered in UI code.",
        ),
    ),
    Rule(
        id="migration",
        title="Migration additivity & safety",
        checks=(
            "Strictly additive: no DROP TABLE/TRIGGER/POLICY/FUNCTION/INDEX/COLUMN.",
            "Guarded idempotent creation (IF NOT EXISTS / DO $$ existence checks).",
            "RLS + org isolation present on any tenant table.",
            "No destructive DELETE/TRUNCATE/UPDATE on raw_* or schema without documented approval.",
        ),
    ),
    Rule(
        id="allowlist",
        title="Middleware allowlist coverage",
        checks=(
            "Every new API route/card has its own middleware.ts allowlist entry.",
            "No route silently 410-quarantined by v2ApiBoundary().",
        ),
    ),
    Rule(
        id="auth",
        title="Auth / authorization on routes",
        checks=(
            "Every allowlisted /api/* route calls getSession()/hasPermission() itself (cookie presence is NOT auth).",
            "No service-role key or secrets leaked in responses or logs.",
            "No IDOR: org scoping enforced server-side, never client-trust only.",
        ),
    ),
    Rule(
        id="raw-purity",
        title="Raw source purity (raw_* tables)",
        checks=(
            "source_payload contains ONLY the source payload — no _rt_extracted / _rt_calculated derived blocks.",
            "No business-logic outputs injected into the raw layer.",
            "Source timestamps / source IDs / payload identity retained.",
        ),
    ),
    Rule(
        id="money",
        title="Money / finance adjacency",
        checks=(
            "Money-movement writes gated and reviewed; no silent mutation of production records.",
            "SALES vs WORKER commission filters never co-mingled (sold-by vs split-tech, sold/won vs completed/invoiced).",
            "Canonical amounts read from raw + middleware read-model, not a form default or hardcoded value.",
            "No .catch(() => []) swallowing a query failure into fabricated zeros.",
        ),
    ),
    Rule(
        id="scope",
        title="Scope discipline & correctness",
        checks=(
            "No unrelated files touched.",
            "No split-literal masking of forbidden table names (${'fact'} / ${'mart'} / ${'dim'}).",
            "Read-model JSON paths valid against the actual raw payload shape.",
        ),
    ),
)


def dispatch_rules(changed_paths: list[str]) -> list[Rule]:
    """Deterministic path→rule mapping. Pure function (no I/O)."""
    if not changed_paths:
        return []
    picked: dict[str, Rule] = {}

    def add(rule_id: str) -> None:
        for r in RULES:
            if r.id == rule_id:
                picked[r.id] = r
                return

    for p in changed_paths:
        pl = p.lower()
        if "lib/calculations" in pl or "__checks__" in pl or "lib/" in pl and "calculations" in pl:
            add("calc")
        if "supabase/migrations" in pl or p.endswith(".sql"):
            add("migration")
        if p.endswith("middleware.ts") or "middleware" in pl:
            add("allowlist")
        if "/api/" in pl and (p.endswith(".ts") or p.endswith(".tsx")):
            add("auth")
        if "raw_" in pl or "sync-" in pl:
            add("raw-purity")
        if any(k in pl for k in ("finance", "commission", "xero", "payroll", "money", "cash", "bank", "invoice")):
            add("money")
        add("scope")
    return list(picked.values())


# ─────────────────────────────────────────────────────────────────────────────
# Diff parsing
# ─────────────────────────────────────────────────────────────────────────────

def parse_diff_paths(diff_text: str) -> list[str]:
    """Extract changed file paths from a unified git diff (headers only)."""
    paths: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("+++ b/"):
            p = line[6:]
            # skip /dev/null (new file deletions show +++ /dev/null)
            if p and p != "/dev/null":
                paths.append(p)
        elif line.startswith("--- a/") and not line.startswith("--- a/"):
            pass
    # dedupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Prompt construction
# ─────────────────────────────────────────────────────────────────────────────

def build_review_prompt(diff_text: str, rules: list[Rule], repo: str | None) -> str:
    rule_block = "\n".join(
        f"- [{r.id}] {r.title}\n" + "".join(f"    * {c}\n" for c in r.checks)
        for r in rules
    )
    return f"""You are the LOCAL REVIEW GATE for Reliable Tradies (repo: {repo or 'unspecified'}).

Review the following unified diff. Do not implement or edit anything.

METHOD (map → trace → validate, then falsify):
1. MAP: identify exactly what this change does and which files it touches.
2. TRACE: for each change, identify what surrounding code depends on that behavior
   (callers, consumers, tests, read-models, routes).
3. VALIDATE: confirm each concern against evidence IN the diff before reporting it.
   A finding is only valid if the diff text actually supports it. If you cannot
   see supporting evidence in the diff, do NOT report it — you do not have repo
   context, and guessing produces false positives.

CHECK SPECIFICALLY against these dispatched criteria:
{rule_block}

OUTPUT FORMAT — return exactly one JSON object (no prose outside it):
{{
  "verdict": "PASS" | "FAIL",
  "findings": [
    {{"severity": "BLOCKER" | "MAJOR" | "MINOR", "file": "<path>", "line": <int or null>, "finding": "<one specific, diff-supported issue>"}}
  ]
}}
A PASS verdict may still include MINOR findings. Use FAIL if any BLOCKER or MAJOR
is present. Every finding MUST cite a file (and line when visible in the diff).

--- BEGIN DIFF ---
{diff_text}
--- END DIFF ---
"""


def build_reflection_prompt(diff_text: str, findings_json: str) -> str:
    return f"""You are an INDEPENDENT REFLECTION filter (falsification-first).

You see ONLY the diff and a reviewer's findings. You do NOT have repository
context. Your single job is to remove findings that are NOT directly supported
by evidence in the diff — a falsification test, not a confirmation test.

For each finding, ask: "Does the diff text itself contain evidence that this
issue is real?" If the answer is NO (the finding requires repo context you do
not have, or is contradicted by the diff), REMOVE it. Keep a finding only if the
diff directly shows the defect (e.g. the flagged line is visible and clearly
does what the finding claims).

IMPORTANT: if a finding's CORE defect is directly visible in the diff but a
QUALIFIER overclaims beyond the diff (e.g. the finding says "drops a LIVE table"
while the diff shows the DROP statement but not the table's liveness), KEEP the
finding — the core defect is real — and note the overclaim in the "removed"
reason text only if you truly drop it. A destructive DROP/TRUNCATE/DELETE, a
hardcoded rate, or business math that is literally present in the diff is a real
defect regardless of qualifier wording.

Do not add new findings. Do not re-word kept findings.

INPUT FINDINGS:
{findings_json}

OUTPUT FORMAT — exactly one JSON object (no prose outside it):
{{
  "verdict": "PASS" | "FAIL",
  "kept": [ ...subset of input findings that are diff-supported... ],
  "removed": [ ...findings removed because not diff-supported, with a one-line reason... ]
}}

--- BEGIN DIFF ---
{diff_text}
--- END DIFF ---
"""


# ─────────────────────────────────────────────────────────────────────────────
# Model client
# ─────────────────────────────────────────────────────────────────────────────

def call_model(endpoint: str, model: str, prompt: str, max_tokens: int, timeout: int) -> str:
    url = endpoint.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "stream": False,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    elapsed = time.time() - t0
    msg = data["choices"][0]["message"]
    content = msg.get("content") or ""
    usage = data.get("usage", {})
    if not content and msg.get("reasoning_content"):
        # reasoning-channel models burn budget into reasoning; surface as error
        raise RuntimeError(
            f"model returned empty content (reasoning_tokens={usage.get('completion_tokens')})"
        )
    return content


def _extract_json(text: str) -> dict[str, Any]:
    """Tolerantly extract a JSON object from a model response."""
    text = text.strip()
    # strip markdown fences
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # find first { ... } balanced
        start = text.find("{")
        if start < 0:
            raise ValueError("no JSON object in response")
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    return json.loads(text[start : i + 1])
        raise ValueError("unbalanced JSON in response")


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ReviewResult:
    verdict: str
    findings: list[dict[str, Any]]
    removed: list[dict[str, Any]]
    rules_applied: list[str]
    changed_files: list[str]
    reviewer_raw: str
    reflection_raw: str
    elapsed_s: float


def review(
    diff_text: str,
    *,
    repo: str | None = None,
    endpoint: str = "http://gb10-reviewer:1234/v1",
    model: str = "qwen3-coder-next",
    max_tokens: int = 24000,
    timeout: int = 600,
    skip_reflection: bool = False,
) -> ReviewResult:
    t0 = time.time()
    paths = parse_diff_paths(diff_text)
    rules = dispatch_rules(paths)
    if not rules:
        # always apply scope discipline even if no path matched
        rules = [r for r in RULES if r.id == "scope"]

    prompt = build_review_prompt(diff_text, rules, repo)
    reviewer_raw = call_model(endpoint, model, prompt, max_tokens, timeout)
    reviewed = _extract_json(reviewer_raw)

    removed: list[dict[str, Any]] = []
    if not skip_reflection and reviewed.get("findings"):
        findings_json = json.dumps(reviewed.get("findings", []), indent=2)
        refl_prompt = build_reflection_prompt(diff_text, findings_json)
        reflection_raw = call_model(endpoint, model, refl_prompt, max_tokens, timeout)
        reflected = _extract_json(reflection_raw)
        removed = reflected.get("removed", [])
        if "verdict" in reflected:
            reviewed["verdict"] = reflected["verdict"]
        reviewed["findings"] = reflected.get("kept", reviewed.get("findings", []))
    else:
        reflection_raw = ""

    return ReviewResult(
        verdict=reviewed.get("verdict", "UNKNOWN"),
        findings=reviewed.get("findings", []),
        removed=removed,
        rules_applied=[r.id for r in rules],
        changed_files=paths,
        reviewer_raw=reviewer_raw,
        reflection_raw=reflection_raw,
        elapsed_s=time.time() - t0,
    )


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Deterministic local review gate")
    ap.add_argument("--diff-file", required=True, help="path to a unified diff (.patch) file")
    ap.add_argument("--repo", default=None, help="repo name/path for context label")
    ap.add_argument("--endpoint", default="http://gb10-reviewer:1234/v1")
    ap.add_argument("--model", default="qwen3-coder-next")
    ap.add_argument("--max-tokens", type=int, default=24000)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--skip-reflection", action="store_true")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON only")
    args = ap.parse_args()

    diff_text = Path(args.diff_file).read_text()

    result = review(
        diff_text,
        repo=args.repo,
        endpoint=args.endpoint,
        model=args.model,
        max_tokens=args.max_tokens,
        timeout=args.timeout,
        skip_reflection=args.skip_reflection,
    )

    if args.json:
        print(json.dumps(
            {
                "verdict": result.verdict,
                "findings": result.findings,
                "removed": result.removed,
                "rules_applied": result.rules_applied,
                "changed_files": result.changed_files,
                "elapsed_s": round(result.elapsed_s, 1),
            },
            indent=2,
        ))
        return 0

    print(f"VERDICT: {result.verdict}")
    print(f"Changed files ({len(result.changed_files)}): {', '.join(result.changed_files)}")
    print(f"Rules applied: {', '.join(result.rules_applied)}")
    print(f"Elapsed: {result.elapsed_s:.1f}s")
    print(f"\nFindings ({len(result.findings)}):")
    for f in result.findings:
        loc = f"{f.get('file','?')}:{f.get('line','?')}" if f.get("file") else "?"
        print(f"  [{f.get('severity','?')}] {loc} — {f.get('finding','')}")
    if result.removed:
        print(f"\nReflection removed ({len(result.removed)} unsupported):")
        for r in result.removed:
            print(f"  - {r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
