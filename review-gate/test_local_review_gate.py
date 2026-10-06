#!/usr/bin/env python3
"""Unit tests for the deterministic local review gate.

Covers the pure/deterministic logic (rule dispatch, diff parsing, JSON
extraction, prompt construction) plus the orchestrator with mocked model calls.
Run:  python3 -m pytest test_local_review_gate.py -q   (or unittest directly)
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_review_gate as rg


# ── dispatch_rules ──────────────────────────────────────────────────────────

def test_dispatch_empty():
    assert rg.dispatch_rules([]) == []


def test_dispatch_scope_always_applied():
    rules = rg.dispatch_rules(["apps/web/app/foo/page.tsx"])
    ids = [r.id for r in rules]
    assert "scope" in ids


def test_dispatch_calc_rule():
    rules = rg.dispatch_rules(["apps/web/lib/calculations/job-economics.ts"])
    assert any(r.id == "calc" for r in rules)


def test_dispatch_migration_rule():
    rules = rg.dispatch_rules(["supabase/migrations/20261006_add_table.sql"])
    assert any(r.id == "migration" for r in rules)


def test_dispatch_allowlist_rule():
    rules = rg.dispatch_rules(["apps/web/middleware.ts"])
    assert any(r.id == "allowlist" for r in rules)


def test_dispatch_auth_rule():
    rules = rg.dispatch_rules(["apps/web/app/api/admin/users/route.ts"])
    assert any(r.id == "auth" for r in rules)


def test_dispatch_raw_purity_rule():
    rules = rg.dispatch_rules(["scripts/sync-xero.py"])
    assert any(r.id == "raw-purity" for r in rules)


def test_dispatch_money_rule():
    rules = rg.dispatch_rules(["apps/web/lib/finance/commissions.ts"])
    assert any(r.id == "money" for r in rules)


def test_dispatch_multiple_rules_on_same_path():
    # a migration touching raw + money keywords triggers several
    rules = rg.dispatch_rules(["supabase/migrations/2026_raw_xero_commission.sql"])
    ids = {r.id for r in rules}
    assert {"migration", "raw-purity", "money", "scope"} <= ids


# ── parse_diff_paths ────────────────────────────────────────────────────────

SAMPLE_DIFF = """\
diff --git a/apps/web/lib/calc.ts b/apps/web/lib/calc.ts
--- a/apps/web/lib/calc.ts
+++ b/apps/web/lib/calc.ts
@@ -1,3 +1,4 @@
+// new line
diff --git a/supabase/migrations/001.sql b/supabase/migrations/001.sql
new file mode 100644
--- /dev/null
+++ b/supabase/migrations/001.sql
+create table foo (id int);
"""


def test_parse_diff_paths_extracts_new_and_modified():
    paths = rg.parse_diff_paths(SAMPLE_DIFF)
    assert "apps/web/lib/calc.ts" in paths
    assert "supabase/migrations/001.sql" in paths
    assert "/dev/null" not in paths


def test_parse_diff_paths_dedupes():
    diff = "+++ b/a.ts\n+++ b/a.ts\n+++ b/b.ts\n"
    assert rg.parse_diff_paths(diff) == ["a.ts", "b.ts"]


# ── _extract_json ───────────────────────────────────────────────────────────

def test_extract_json_plain():
    assert rg._extract_json('{"verdict":"PASS"}') == {"verdict": "PASS"}


def test_extract_json_with_markdown_fence():
    out = rg._extract_json('```json\n{"verdict":"FAIL"}\n```')
    assert out == {"verdict": "FAIL"}


def test_extract_json_with_prose_around():
    out = rg._extract_json('here is my answer: {"verdict":"PASS","findings":[]} done')
    assert out["verdict"] == "PASS"


def test_extract_json_no_object_raises():
    try:
        rg._extract_json("no json here")
        assert False, "expected ValueError"
    except ValueError:
        pass


# ── prompt construction ─────────────────────────────────────────────────────

def test_build_review_prompt_contains_rules_and_diff():
    rules = [r for r in rg.RULES if r.id == "calc"]
    p = rg.build_review_prompt("+++ b/x.ts\n+foo", rules, "test-repo")
    assert "map" in p.lower() and "trace" in p.lower() and "validate" in p.lower()
    assert "Canonical calculation" in p
    assert "+++ b/x.ts" in p
    assert "test-repo" in p


def test_build_reflection_prompt_falsification_first():
    p = rg.build_reflection_prompt("+++ b/x.ts\n", json.dumps([{"severity": "MAJOR"}]))
    assert "falsification" in p.lower()
    assert "REMOVE" in p


# ── orchestrator with mocked model ─────────────────────────────────────────

class _FakeModel:
    """Returns a canned review then a canned reflection."""

    def __init__(self):
        self.calls = 0

    def __call__(self, endpoint, model, prompt, max_tokens, timeout):
        self.calls += 1
        if self.calls == 1:
            return json.dumps({
                "verdict": "FAIL",
                "findings": [
                    {"severity": "MAJOR", "file": "a.ts", "line": 1, "finding": "real issue"},
                    {"severity": "MAJOR", "file": "a.ts", "line": None, "finding": "hallucinated issue"},
                ],
            })
        return json.dumps({
            "verdict": "FAIL",
            "kept": [{"severity": "MAJOR", "file": "a.ts", "line": 1, "finding": "real issue"}],
            "removed": [{"severity": "MAJOR", "file": "a.ts", "finding": "hallucinated issue"}],
        })


def test_review_orchestrator_flow(monkeypatch):
    fake = _FakeModel()
    monkeypatch.setattr(rg, "call_model", fake)
    result = rg.review("+++ b/a.ts\n+broken code", repo="x", endpoint="http://x/v1", model="m")
    assert result.verdict == "FAIL"
    assert len(result.findings) == 1
    assert result.findings[0]["finding"] == "real issue"
    assert len(result.removed) == 1
    assert fake.calls == 2  # review + reflection
    assert result.rules_applied  # scope at minimum


def test_review_skip_reflection_single_call(monkeypatch):
    fake = _FakeModel()
    monkeypatch.setattr(rg, "call_model", fake)
    result = rg.review("+++ b/a.ts\n+x", repo="x", skip_reflection=True)
    assert fake.calls == 1
    assert len(result.findings) == 2  # both findings kept (no reflection)


def test_deterministic_detects_destructive_ddl():
    diff = "+++ b/migrations/1.sql\n+DROP TABLE raw_servicetitan_jobs;\n+TRUNCATE raw_servicetitan_jobs;"
    findings = rg.deterministic_findings(diff)
    assert len(findings) == 2
    assert all(f["severity"] == "BLOCKER" for f in findings)


def test_deterministic_detects_forbidden_read():
    diff = "+++ b/app/page.tsx\n+const d = await query('SELECT * FROM fact_job_economics');"
    findings = rg.deterministic_findings(diff)
    assert len(findings) == 1
    assert findings[0]["severity"] == "BLOCKER"


def test_deterministic_detects_delete_on_raw():
    diff = "+++ b/x.ts\n+DELETE FROM raw_servicetitan_jobs WHERE id=1;"
    findings = rg.deterministic_findings(diff)
    assert len(findings) == 1
    assert findings[0]["severity"] == "BLOCKER"


def test_deterministic_ignores_comments():
    diff = "+++ b/app/route.ts\n+ * Must NOT use DATABASE_URL.\n+// do not read fact_ tables\n+export const x = 1;"
    findings = rg.deterministic_findings(diff)
    assert findings == []


def test_strip_comments_trailing():
    assert rg._strip_comments("const x = 1; // uses DATABASE_URL") == "const x = 1; "
    assert rg._strip_comments("  * doc line") == ""
    assert rg._strip_comments("-- DROP TABLE raw_x") == ""


def test_deterministic_only_no_model_calls(monkeypatch):
    fake = _FakeModel()
    monkeypatch.setattr(rg, "call_model", fake)
    diff = "+++ b/migrations/1.sql\n+DROP TABLE raw_x;"
    result = rg.review(diff, deterministic_only=True)
    assert fake.calls == 0
    assert result.verdict == "FAIL"
    assert result.rules_applied == ["deterministic-lint"]


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))
