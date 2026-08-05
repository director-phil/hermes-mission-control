#!/usr/bin/env python3
"""
Hermes Native Goal Runtime - Controller for native goal execution.

Implements atomic claim, PID/start-tick lock, deterministic acceptance,
and Hermes reviewer/coder subprocess orchestration per the approved canary contract.

All subprocess interaction uses injectable adapters so --self-test can prove
every lifecycle and failure path without real model/network calls.
"""

import argparse
import hashlib
import json
import os
import re
import stat as stat_module
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Protocol

HOME = os.path.expanduser("~")
DEFAULT_NATIVE_ROOT = Path(HOME) / ".hermes" / "mission-control" / "runtime"
DEFAULT_ALLOWED_WORKTREE_ROOTS = [Path(HOME) / ".hermes" / "mission-control-worktrees"]
FORBIDDEN_WORKTREE_ROOTS = [Path(HOME) / "Documents" / "GitHub" / "reliable-tradies-ops"]
MAX_GOAL_CONTRACT_BYTES = 16_384
MAX_COMPLETE_PROMPT_BYTES = 32_768
MAX_MARKER_STDOUT_BYTES = 4_096

# Contract markers - exact strings required by controller
PLAN_APPROVED_MARKER = "PLAN_APPROVED"
REVIEW_PASS_MARKER = "REVIEW_PASS"


class TerminalMoveError(RuntimeError):
    """Raised when terminal markdown move fails after result evidence is written."""


# ---------------------------------------------------------------------------
# Subprocess adapter protocol (injectable for tests)
# ---------------------------------------------------------------------------

class SubprocessAdapter(Protocol):
    def run_command(
        self,
        cmd: list[str],
        cwd: str,
        timeout: int,
        env: dict[str, str] | None,
        capture: bool,
        stdin_data: str | None = None,
    ) -> "CmdResult": ...


class CmdResult:
    __slots__ = ("returncode", "stdout", "stderr", "stdout_bytes", "stderr_bytes")

    def __init__(
        self,
        returncode: int,
        stdout: str = "",
        stderr: str = "",
        stdout_bytes: int = 0,
        stderr_bytes: int = 0,
    ):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.stdout_bytes = stdout_bytes
        self.stderr_bytes = stderr_bytes


class RealSubprocess:
    """Production subprocess adapter."""

    def run_command(
        self,
        cmd: list[str],
        cwd: str,
        timeout: int,
        env: dict[str, str] | None,
        capture: bool,
        stdin_data: str | None = None,
    ) -> CmdResult:
        try:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=capture,
                text=True,
                timeout=timeout,
                env=env,
                input=stdin_data,
            )
            return CmdResult(
                returncode=result.returncode,
                stdout=result.stdout if capture else "",
                stderr=result.stderr if capture else "",
                stdout_bytes=len((result.stdout or "").encode()) if capture else 0,
                stderr_bytes=len((result.stderr or "").encode()) if capture else 0,
            )
        except subprocess.TimeoutExpired:
            return CmdResult(returncode=-1, stdout="", stderr="timeout")
        except Exception as e:
            return CmdResult(returncode=-1, stdout="", stderr=str(e))


def allowed_worktree_roots() -> list[Path]:
    configured = os.environ.get("HERMES_NATIVE_ALLOWED_WORKTREE_ROOTS", "")
    roots = [Path(item).expanduser() for item in configured.split(os.pathsep) if item.strip()]
    return roots or DEFAULT_ALLOWED_WORKTREE_ROOTS


def path_within(path_value: Path, root_value: Path) -> bool:
    try:
        path_value.resolve().relative_to(root_value.resolve())
        return True
    except ValueError:
        return False


def path_only_absolute(path_value: Path) -> Path:
    """Normalize a path without filesystem inspection."""
    return Path(os.path.abspath(os.path.expanduser(os.fspath(path_value))))


def path_within_path_only(path_value: Path, root_value: Path) -> bool:
    """Return whether path_value is within root_value without stat/resolve calls."""
    try:
        path_only_absolute(path_value).relative_to(path_only_absolute(root_value))
        return True
    except ValueError:
        return False


def validate_goal_worktree(
    worktree: Path,
    native_root: Path,
    subprocess_adapter: SubprocessAdapter,
) -> tuple[bool, str]:
    """Validate worktree path before any model subprocess is invoked."""
    path_only_worktree = path_only_absolute(worktree)
    if path_within_path_only(path_only_worktree, native_root):
        return False, "worktree path is inside native runtime root"
    for forbidden in FORBIDDEN_WORKTREE_ROOTS:
        if path_within_path_only(path_only_worktree, forbidden):
            return False, "worktree path is forbidden"
    if not any(path_within_path_only(path_only_worktree, allowed) for allowed in allowed_worktree_roots()):
        return False, "worktree path is outside allowed roots"

    try:
        resolved = worktree.expanduser().resolve()
    except OSError:
        return False, "worktree path cannot be resolved"
    if path_within(resolved, native_root):
        return False, "worktree path is inside native runtime root"
    for forbidden in FORBIDDEN_WORKTREE_ROOTS:
        if path_within(resolved, forbidden):
            return False, "worktree path is forbidden"
    if not any(path_within(resolved, allowed) for allowed in allowed_worktree_roots()):
        return False, "worktree path is outside allowed roots"
    if not resolved.exists() or not resolved.is_dir():
        return False, "worktree path does not exist or is not a directory"
    git_check = subprocess_adapter.run_command(
        cmd=["git", "rev-parse", "--is-inside-work-tree"],
        cwd=str(resolved), timeout=30, env=None, capture=True,
    )
    if git_check.returncode != 0 or git_check.stdout.strip() != "true":
        return False, "worktree path is not a Git worktree"
    return True, ""


# ---------------------------------------------------------------------------
# /proc stat helper — correct parsing after last ')'
# ---------------------------------------------------------------------------

def parse_proc_stat(stat_content: str) -> tuple[int | None, int | None]:
    """
    Parse /proc/<pid>/stat safely.
    Returns (ppid, starttime) from fields after the comm name.
    The comm field is enclosed in parens and may contain spaces, parens, etc.
    """
    close = stat_content.rfind(")")
    if close < 0:
        return None, None
    remainder = stat_content[close + 2:].strip().split()
    # After ')': state(0) ppid(1) ... starttime(19)
    if len(remainder) < 20:
        return None, None
    try:
        ppid = int(remainder[1])
        starttime = int(remainder[19])
        return ppid, starttime
    except (ValueError, IndexError):
        return None, None


def get_process_start_ticks(pid: int) -> int | None:
    """Get start_ticks for a PID from /proc/<pid>/stat."""
    stat_path = Path("/proc") / str(pid) / "stat"
    try:
        stat_content = stat_path.read_text(encoding="utf-8")
        _, starttime = parse_proc_stat(stat_content)
        return starttime if starttime is not None and starttime > 0 else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Atomic file I/O helpers
# ---------------------------------------------------------------------------

def fsync_dir(dir_path: Path) -> None:
    """Fsync a directory to ensure metadata durability."""
    fd = os.open(str(dir_path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ensure_dir_durable(dir_path: Path) -> None:
    """Create a directory tree and fsync every newly-created parent on Linux."""
    missing: list[Path] = []
    current = dir_path
    while not current.exists():
        missing.append(current)
        if current.parent == current:
            break
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir()
        fsync_dir(directory.parent)
        fsync_dir(directory)
    if not missing:
        dir_path.mkdir(parents=True, exist_ok=True)


def atomic_write_json(target: Path, data: dict) -> None:
    """Write JSON atomically via temp sibling + fsync + os.replace + dir fsync."""
    ensure_dir_durable(target.parent)
    tmp = target.with_suffix(".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        payload = json.dumps(data, indent=2).encode("utf-8")
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(tmp), str(target))
    fsync_dir(target.parent)


def append_jsonl(path: Path, record: dict) -> None:
    """Append one JSONL line with fsync."""
    ensure_dir_durable(path.parent)
    line = json.dumps(record, separators=(",", ":")) + "\n"
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_dir(path.parent)


# ---------------------------------------------------------------------------
# Event logging (metadata only — no prompts/output/diffs)
# ---------------------------------------------------------------------------

def log_event(events_path: Path, event_type: str, summary: str, metadata: dict) -> None:
    """Append a metadata-only JSONL event record."""
    record = {
        "timestamp": datetime.now(UTC).isoformat(),
        "type": event_type,
        "summary": summary,
        "metadata": metadata,
    }
    append_jsonl(events_path, record)


# ---------------------------------------------------------------------------
# O_EXCL controller lock
# ---------------------------------------------------------------------------

def create_controller_lock(lock_path: Path, goal_id: str, pid: int, start_ticks: int | None) -> bool:
    """
    Create controller lock with O_CREAT|O_EXCL.
    Returns True on success. Never overwrites an existing lock.
    """
    if not isinstance(start_ticks, int) or start_ticks <= 0:
        return False
    payload = json.dumps({
        "goal_id": goal_id,
        "pid": pid,
        "proc_start_ticks": start_ticks,
        "created_at": datetime.now(UTC).isoformat(),
    }).encode("utf-8")
    try:
        fd = os.open(
            str(lock_path),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        return False
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_dir(lock_path.parent)
    return True


def validate_lock(lock_path: Path) -> tuple[bool, dict | None]:
    """
    Validate lock is live by checking PID existence + start_ticks match.
    Uses parse_proc_stat for correct field extraction.
    """
    if not lock_path.exists():
        return False, None
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        pid = data.get("pid")
        expected_ticks = data.get("proc_start_ticks")
        if not isinstance(pid, int) or pid <= 0 or not isinstance(expected_ticks, int) or expected_ticks <= 0:
            return False, data

        stat_path = Path("/proc") / str(pid) / "stat"
        if not stat_path.exists():
            return False, data
        stat_content = stat_path.read_text(encoding="utf-8")
        _, actual_ticks = parse_proc_stat(stat_content)
        if actual_ticks is None or actual_ticks != expected_ticks:
            return False, data
        return True, data
    except Exception:
        return False, None


def cleanup_owned_lock(lock_path: Path, goal_id: str, pid: int, start_ticks: int | None) -> None:
    """Remove lock only if it is still owned by this goal+pid+start_ticks."""
    if not isinstance(start_ticks, int) or start_ticks <= 0:
        return
    if not lock_path.exists():
        return
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if (
            data.get("goal_id") == goal_id
            and data.get("pid") == pid
            and data.get("proc_start_ticks") == start_ticks
        ):
            lock_path.unlink(missing_ok=True)
            fsync_dir(lock_path.parent)
    except Exception:
        pass


def recover_stale_lock(native_root: Path) -> bool:
    """Remove controller.lock only when PID/start-ticks prove it is stale."""
    lock_path = native_root / "controller.lock"
    if not lock_path.exists():
        return True
    live, data = validate_lock(lock_path)
    if live:
        return False
    if not data:
        log_controller_warning_once(
            native_root,
            "Native controller lock invalid or unreadable; claims blocked fail-closed",
            {"lock_path": str(lock_path), "lock_invalid": True, "content_recorded": False},
            f"lock-invalid:{lock_warning_identity(lock_path)}",
        )
        return False
    goal_id = str(data.get("goal_id") or "unknown")
    pid = data.get("pid")
    expected_ticks = data.get("proc_start_ticks")
    if not isinstance(pid, int) or pid <= 0 or not isinstance(expected_ticks, int) or expected_ticks <= 0:
        log_controller_warning_once(
            native_root,
            "Native controller lock invalid; claims blocked fail-closed",
            {
                "lock_path": str(lock_path),
                "goal_id": goal_id,
                "pid_valid": isinstance(pid, int) and pid > 0,
                "proc_start_ticks_valid": isinstance(expected_ticks, int) and expected_ticks > 0,
                "lock_invalid": True,
                "content_recorded": False,
            },
            f"lock-invalid:{lock_warning_identity(lock_path)}",
        )
        return False
    stat_path = Path("/proc") / str(pid) / "stat"
    proven_stale = not stat_path.exists()
    if not proven_stale:
        try:
            _, actual_ticks = parse_proc_stat(stat_path.read_text(encoding="utf-8"))
            proven_stale = actual_ticks is not None and actual_ticks != expected_ticks
        except Exception:
            proven_stale = False
    if not proven_stale:
        return False
    lock_path.unlink(missing_ok=True)
    fsync_dir(lock_path.parent)
    log_event(
        native_root / "runs" / goal_id / "events.jsonl",
        "controller.lock_recovered",
        "Recovered stale native controller lock",
        {"pid": pid, "proc_start_ticks": expected_ticks, "recovery": True},
    )
    return True


def has_terminal_result(native_root: Path, goal_id: str) -> bool:
    result_path = native_root / "runs" / goal_id / "result.json"
    try:
        data = json.loads(result_path.read_text(encoding="utf-8"))
        return result_goal_id_matches(data, goal_id) and (data.get("success") is True or data.get("success") is False)
    except Exception:
        return False


def recover_orphan_running_goals(native_root: Path) -> None:
    """Move orphan running markdown back to ready only when no lock exists."""
    lock_path = native_root / "controller.lock"
    if lock_path.exists():
        return
    running_dir = native_root / "goals" / "running"
    ready_dir = native_root / "goals" / "ready"
    if not running_dir.exists():
        return
    ensure_dir_durable(ready_dir)
    for running_path in sorted(running_dir.glob("*.md")):
        goal_id = running_path.stem
        if has_terminal_result(native_root, goal_id):
            continue
        ready_path = ready_dir / running_path.name
        if ready_path.exists():
            log_event(
                native_root / "runs" / goal_id / "events.jsonl",
                "controller.warning",
                "Orphan running goal recovery skipped because ready goal exists",
                {"goal_id": goal_id, "terminal": False, "recovery": "skipped-ready-exists"},
            )
            continue
        try:
            os.replace(str(running_path), str(ready_path))
            fsync_dir(ready_dir)
            fsync_dir(running_dir)
            log_event(
                native_root / "runs" / goal_id / "events.jsonl",
                "controller.warning",
                "Recovered orphan running goal to ready",
                {"goal_id": goal_id, "terminal": False, "recovery": "running-to-ready"},
            )
        except OSError as exc:
            log_controller_warning(
                native_root,
                "Failed to recover orphan running goal",
                {"goal_id": goal_id, "errno": exc.errno, "terminal": False},
            )


# ---------------------------------------------------------------------------
# Goal markdown parsing
# ---------------------------------------------------------------------------

def parse_goal_markdown(content: str) -> dict:
    """
    Parse goal markdown to extract frontmatter fields, allowed_files, and acceptance body.
    Preserves the fenced bash body byte-for-byte.
    Fails if required fields or acceptance block are absent.
    """
    lines = content.split("\n")

    if not lines or lines[0].strip() != "---":
        raise ValueError("goal missing opening frontmatter fence")

    fm_lines: list[str] = []
    fm_end: int | None = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            fm_end = i
            break
        fm_lines.append(line)

    if fm_end is None:
        raise ValueError("goal missing closing frontmatter fence")

    metadata: dict[str, str] = {}
    for fm_line in fm_lines:
        if ":" in fm_line:
            key, value = fm_line.split(":", 1)
            metadata[key.strip()] = value.strip()

    body_start_offset = 0
    offset = 0
    for i, line in enumerate(lines):
        offset += len(line)
        if i < len(lines) - 1:
            offset += 1
        if i == fm_end:
            body_start_offset = offset
            break
    body = content[body_start_offset:].strip()

    goal_data: dict[str, Any] = {
        "title": metadata.get("title", ""),
        "repo_worktree": metadata.get("repo/workdir", metadata.get("worktree", "")),
        "dependencies": [d.strip() for d in metadata.get("dependencies", "").split(",") if d.strip()],
        "goal_contract": body,
    }

    # Parse allowed_files section
    allowed_files: list[str] = []
    in_allowed = False
    for line in lines:
        if line.strip().startswith("## Allowed") or line.strip().startswith("### Allowed"):
            in_allowed = True
            continue
        if in_allowed and line.startswith("## "):
            in_allowed = False
        if in_allowed and line.startswith("- "):
            path_part = line[2:].strip()
            # Remove backticks if present
            path_part = path_part.strip("`")
            if path_part:
                allowed_files.append(path_part)

    # Also check for allowed_files in frontmatter
    if "allowed_files" in metadata:
        for f in metadata["allowed_files"].split(","):
            f = f.strip().strip("`")
            if f:
                allowed_files.append(f)

    goal_data["allowed_files"] = allowed_files

    goal_data["acceptance_body"] = extract_acceptance_body(content)

    # Validate required fields
    if not goal_data["title"]:
        raise ValueError("goal missing required field: title")
    if not goal_data["repo_worktree"]:
        raise ValueError("goal missing required field: repo/workdir or worktree")
    if not goal_data["acceptance_body"]:
        raise ValueError("goal missing acceptance block")
    if not allowed_files:
        raise ValueError("goal missing required Allowed files")
    validate_prompt_contract_fits(goal_data)

    return goal_data


def extract_acceptance_body(content: str) -> str:
    """Extract fenced bash body using original string offsets."""
    section = re.search(r"(?m)^## Acceptance[ \t]*\r?$", content)
    if not section:
        return ""
    next_section = re.search(r"(?m)^## [^\n\r]*[ \t]*\r?$", content[section.end():])
    search_end = section.end() + next_section.start() if next_section else len(content)
    fence_open = re.search(r"(?m)^```bash[ \t]*\r?$", content[section.end():search_end])
    if not fence_open:
        return ""
    open_abs_start = section.end() + fence_open.start()
    open_abs_end = section.end() + fence_open.end()
    if content.startswith("\r\n", open_abs_end):
        body_start = open_abs_end + 2
    elif content.startswith("\n", open_abs_end):
        body_start = open_abs_end + 1
    else:
        body_start = open_abs_end
    fence_close = re.search(r"(?m)^```[ \t]*\r?$", content[body_start:search_end])
    if not fence_close:
        return ""
    body_end = body_start + fence_close.start()
    return content[body_start:body_end]


def validate_prompt_contract_fits(goal_data: dict) -> None:
    """Fail parsing if the full deterministic prompts cannot carry the contract."""
    for prompt_kind in ("plan", "code", "review"):
        prompt = build_prompt(
            prompt_kind,
            goal_data,
            changed_count=0,
            acceptance_exit=0,
        )
        if len(prompt.encode("utf-8")) > MAX_COMPLETE_PROMPT_BYTES:
            raise ValueError(f"goal contract exceeds {prompt_kind} prompt byte cap")


def exact_stdout_marker(stdout: str, marker: str) -> bool:
    """Accept only bounded stdout whose surrounding-whitespace-stripped body is exactly marker."""
    encoded = stdout.encode("utf-8")
    if len(encoded) > MAX_MARKER_STDOUT_BYTES:
        return False
    return stdout.strip() == marker


def build_prompt(
    prompt_kind: str,
    goal_data: dict,
    changed_count: int = 0,
    acceptance_exit: int | None = None,
) -> str:
    """Build the deterministic bounded prompt contract shared by all model stages."""
    worktree = goal_data.get("repo_worktree", "")
    allowed_files_text = "\n".join(f"- {item}" for item in goal_data.get("allowed_files", []))
    acceptance_body = goal_data.get("acceptance_body", "")
    acceptance_sha = hashlib.sha256(acceptance_body.encode("utf-8")).hexdigest()
    base = (
        f"Goal: {goal_data['title']}\n"
        f"Worktree: {worktree}\n"
        f"Allowed files:\n{allowed_files_text}\n\n"
        f"Requirements:\n{goal_data.get('goal_contract', '')}\n\n"
        f"Acceptance SHA-256: {acceptance_sha}\n"
        f"Acceptance command:\n{acceptance_body}\n"
    )
    if prompt_kind == "plan":
        prompt = base + "\nRespond with exactly PLAN_APPROVED if you approve the plan."
    elif prompt_kind == "code":
        prompt = base + "\nImplement the goal."
    elif prompt_kind == "review":
        prompt = (
            base
            + f"\nChanged files: {changed_count}\n"
            + f"Acceptance exit: {acceptance_exit if acceptance_exit is not None else 'unknown'}\n"
            + "Respond with exactly REVIEW_PASS if the review passes."
        )
    else:
        raise ValueError(f"unknown prompt kind: {prompt_kind}")
    if len(prompt.encode("utf-8")) > MAX_COMPLETE_PROMPT_BYTES:
        raise ValueError(f"{prompt_kind} prompt exceeds {MAX_COMPLETE_PROMPT_BYTES} byte cap")
    return prompt


def terminal_result_exists(native_root: Path, goal_id: str, success: bool) -> bool:
    result_path = native_root / "runs" / goal_id / "result.json"
    try:
        data = json.loads(result_path.read_text(encoding="utf-8"))
        return result_goal_id_matches(data, goal_id) and data.get("success") is success
    except Exception:
        return False


def result_goal_id_matches(data: dict[str, Any], goal_id: str) -> bool:
    result_goal_id = data.get("goal_id")
    return (
        isinstance(result_goal_id, str)
        and 0 < len(result_goal_id) <= 128
        and result_goal_id == goal_id
    )


def dependency_satisfied(native_root: Path, dep_id: str) -> bool:
    return (
        (native_root / "goals" / "done" / f"{dep_id}.md").exists()
        and terminal_result_exists(native_root, dep_id, True)
    )


def quarantine_invalid_goal(native_root: Path, goal_path: Path, reason: str) -> None:
    """Move an invalid ready goal to failed with metadata-only evidence."""
    goal_id = goal_path.stem
    failed_dir = native_root / "goals" / "failed"
    ensure_dir_durable(failed_dir)
    events_path = native_root / "runs" / goal_id / "events.jsonl"
    try:
        os.replace(str(goal_path), str(failed_dir / f"{goal_id}.md"))
        fsync_dir(failed_dir)
        fsync_dir(goal_path.parent)
    except OSError as exc:
        log_event(events_path, "quarantine.failed", "Invalid goal quarantine move failed", {"errno": exc.errno})
        raise
    write_terminal_result(native_root, goal_id, False, {"claim": {"passed": False, "reason": reason}})
    log_event(events_path, "goal.failed", "Invalid goal file quarantined", {"reason": reason})


def log_dependency_blocked_goal(native_root: Path, goal_id: str, blocker_ids: list[str]) -> None:
    """Leave dependency-blocked goals ready and emit non-terminal metadata evidence."""
    log_event(
        native_root / "runs" / goal_id / "events.jsonl",
        "goal.blocked",
        "Ready goal is waiting for dependencies",
        {
            "queue_state": "ready",
            "blocker_ids": blocker_ids,
            "dependency_ids": blocker_ids,
            "terminal": False,
        },
    )


# ---------------------------------------------------------------------------
# Claim goal
# ---------------------------------------------------------------------------

def claim_ready_goal(native_root: Path) -> tuple[Path | None, dict | None]:
    """Atomically claim one ready goal. Returns (running_path, goal_data) or (None, None)."""
    if not recover_stale_lock(native_root):
        return None, None
    recover_orphan_running_goals(native_root)
    ready_dir = native_root / "goals" / "ready"
    running_dir = native_root / "goals" / "running"
    if not ready_dir.exists():
        return None, None

    goal_files = sorted(ready_dir.glob("*.md"))
    if not goal_files:
        return None, None

    for goal_path in goal_files:
        goal_id = goal_path.stem

        # Parse goal
        try:
            content = goal_path.read_text(encoding="utf-8")
            goal_data = parse_goal_markdown(content)
        except UnicodeDecodeError:
            quarantine_invalid_goal(native_root, goal_path, "invalid_utf8")
            continue
        except OSError:
            quarantine_invalid_goal(native_root, goal_path, "unreadable")
            continue
        except ValueError as exc:
            quarantine_invalid_goal(native_root, goal_path, str(exc))
            continue

        goal_data["goal_id"] = goal_id

        # Check dependencies without letting one blocked file idle the queue.
        blocker_ids = [
            dep_id
            for dep_id in goal_data.get("dependencies", [])
            if not dependency_satisfied(native_root, dep_id)
        ]
        if blocker_ids:
            log_dependency_blocked_goal(native_root, goal_id, blocker_ids)
            continue

        # Create the exclusive controller lock before making the goal visible as running.
        pid = os.getpid()
        start_ticks = get_process_start_ticks(pid)
        if start_ticks is None:
            log_controller_warning_once(
                native_root,
                "Unable to read positive proc start ticks; claims blocked fail-closed",
                {
                    "goal_id": goal_id,
                    "pid": pid,
                    "proc_start_ticks_valid": False,
                    "terminal": False,
                },
                f"proc-start-unavailable:{goal_id}",
            )
            return None, None
        lock_path = native_root / "controller.lock"
        if not create_controller_lock(lock_path, goal_id, pid, start_ticks):
            return None, None

        # Atomic claim: move to running only after O_EXCL lock ownership is established.
        ensure_dir_durable(running_dir)
        running_path = running_dir / f"{goal_id}.md"
        try:
            os.replace(str(goal_path), str(running_path))
            fsync_dir(running_dir)
            fsync_dir(ready_dir)
        except OSError as exc:
            cleanup_owned_lock(lock_path, goal_id, pid, start_ticks)
            log_controller_warning(
                native_root,
                "Failed to move ready goal to running after lock acquisition",
                {"goal_id": goal_id, "errno": exc.errno, "owned_lock_cleaned": True, "terminal": False},
            )
            continue

        log_event(
            native_root / "runs" / goal_id / "events.jsonl",
            "goal.claimed",
            f"Claimed goal {goal_id}",
            {"pid": pid, "start_ticks": start_ticks},
        )

        goal_data["_controller_pid"] = pid
        goal_data["_controller_start_ticks"] = start_ticks
        return running_path, goal_data

    return None, None


# ---------------------------------------------------------------------------
# Hermes subprocess execution
# ---------------------------------------------------------------------------

def _minimal_env() -> dict[str, str]:
    """Construct minimal allowlisted environment for subprocesses."""
    env: dict[str, str] = {}
    for key in ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL"):
        if key in os.environ:
            env[key] = os.environ[key]
    env["CI"] = "true"
    env["HERMES_LANGFUSE_CAPTURE_CONTENT"] = "false"
    env["HERMES_LANGFUSE_CAPTURE_TOOL_IO"] = "false"
    return env


_BOUNDED_IDENTIFIER_RE = re.compile(r"[^A-Za-z0-9_.:-]+")


def bounded_identifier(value: str, fallback: str, max_len: int = 128) -> str:
    """Return a bounded non-secret identifier safe for subprocess correlation env."""
    cleaned = _BOUNDED_IDENTIFIER_RE.sub("-", value).strip("-._:")
    return (cleaned or fallback)[:max_len]


def _stage_env(goal_id: str, run_id: str, stage: str, profile: str) -> dict[str, str]:
    env = _minimal_env()
    env.update({
        "HERMES_MISSION_GOAL_ID": bounded_identifier(goal_id, "unknown-goal"),
        "HERMES_MISSION_RUN_ID": bounded_identifier(run_id, "unknown-run"),
        "HERMES_MISSION_STAGE": bounded_identifier(stage, "unknown-stage", max_len=64),
        "HERMES_MISSION_PROFILE": bounded_identifier(profile, "unknown-profile", max_len=64),
    })
    return env


def run_hermes_planner(
    worktree: Path,
    goal_id: str,
    run_id: str,
    goal_prompt: str,
    subprocess_adapter: SubprocessAdapter,
) -> dict:
    """
    Run planner via `hermes --profile reviewer chat --query-file - --source mission-control-goal-plan`.
    Returns metadata-only dict with exit, duration, marker_found, output byte counts.
    """
    cmd = [
        "hermes", "--profile", "reviewer",
        "chat", "--query-file", "-",
        "--source", "mission-control-goal-plan",
    ]
    t0 = time.monotonic()
    result = subprocess_adapter.run_command(
        cmd=cmd, cwd=str(worktree), timeout=300,
        env=_stage_env(goal_id, run_id, "plan", "reviewer"), capture=True,
        stdin_data=goal_prompt,
    )
    duration = time.monotonic() - t0
    marker_found = exact_stdout_marker(result.stdout, PLAN_APPROVED_MARKER)
    return {
        "exit_code": result.returncode,
        "duration_sec": round(duration, 2),
        "stdout_bytes": result.stdout_bytes,
        "stderr_bytes": result.stderr_bytes,
        "marker_found": marker_found,
        "passed": result.returncode == 0 and marker_found and result.stdout_bytes > 0,
    }


def run_hermes_coder(
    worktree: Path,
    goal_id: str,
    run_id: str,
    goal_prompt: str,
    subprocess_adapter: SubprocessAdapter,
) -> dict:
    """
    Run coder via `hermes --profile coder chat --query-file - --source mission-control-goal-code`.
    Coder requires exit 0 only — no marker.
    """
    cmd = [
        "hermes", "--profile", "coder",
        "chat", "--query-file", "-",
        "--source", "mission-control-goal-code",
    ]
    t0 = time.monotonic()
    result = subprocess_adapter.run_command(
        cmd=cmd, cwd=str(worktree), timeout=600,
        env=_stage_env(goal_id, run_id, "code", "coder"), capture=True,
        stdin_data=goal_prompt,
    )
    duration = time.monotonic() - t0
    return {
        "exit_code": result.returncode,
        "duration_sec": round(duration, 2),
        "stdout_bytes": result.stdout_bytes,
        "stderr_bytes": result.stderr_bytes,
        "marker_found": True,  # Coder has no marker requirement
        "passed": result.returncode == 0,
    }


def run_hermes_reviewer(
    worktree: Path,
    goal_id: str,
    run_id: str,
    review_prompt: str,
    subprocess_adapter: SubprocessAdapter,
) -> dict:
    """
    Run reviewer via `hermes --profile reviewer chat --query-file - --source mission-control-goal-review`.
    Reviewer requires REVIEW_PASS in stdout.
    """
    cmd = [
        "hermes", "--profile", "reviewer",
        "chat", "--query-file", "-",
        "--source", "mission-control-goal-review",
    ]
    t0 = time.monotonic()
    result = subprocess_adapter.run_command(
        cmd=cmd, cwd=str(worktree), timeout=300,
        env=_stage_env(goal_id, run_id, "review", "reviewer"), capture=True,
        stdin_data=review_prompt,
    )
    duration = time.monotonic() - t0
    marker_found = exact_stdout_marker(result.stdout, REVIEW_PASS_MARKER)
    return {
        "exit_code": result.returncode,
        "duration_sec": round(duration, 2),
        "stdout_bytes": result.stdout_bytes,
        "stderr_bytes": result.stderr_bytes,
        "marker_found": marker_found,
        "passed": result.returncode == 0 and marker_found and result.stdout_bytes > 0,
    }


# ---------------------------------------------------------------------------
# Git diff / scope checks
# ---------------------------------------------------------------------------

def check_git_scope(
    worktree: Path,
    allowed_files: list[str],
    subprocess_adapter: SubprocessAdapter,
) -> dict:
    """
    Check git diff scope with --porcelain=v1 -z for safe parsing.
    Checks changed files, untracked, binary/NUL, and allowed-file closure.
    Returns metadata dict with passed, changed_files count, violations.
    """
    # Get changed + untracked with NUL-separated output
    result = subprocess_adapter.run_command(
        cmd=["git", "status", "--porcelain=v1", "-z"],
        cwd=str(worktree), timeout=30, env=None, capture=True,
    )
    if result.returncode != 0:
        return {"passed": False, "reason": "git status failed", "changed_count": 0}

    raw = result.stdout
    if not raw.strip("\x00").strip():
        return {"passed": False, "reason": "no git changes detected (empty diff)", "changed_count": 0}

    # Parse NUL-separated porcelain v1 output
    changed_paths: list[str] = []
    untracked_paths: list[str] = []
    entries = raw.split("\x00")
    i = 0
    while i < len(entries):
        entry = entries[i]
        if not entry:
            i += 1
            continue
        status_code = entry[:2]
        filepath = entry[3:]
        # Renames (R) and copies (C) have a second NUL-separated field (source)
        if status_code[0] in ("R", "C"):
            changed_paths.append(filepath)  # destination
            i += 1  # skip source path
            if i < len(entries):
                changed_paths.append(entries[i])  # source also in scope
        else:
            changed_paths.append(filepath)
            if status_code == "??":
                untracked_paths.append(filepath)
        i += 1

    if not changed_paths:
        return {"passed": False, "reason": "no git changes detected", "changed_count": 0}

    # Normalize and check allow-list
    norm_allowed = {os.path.normpath(f) for f in allowed_files}
    violations: list[str] = []
    for p in changed_paths:
        norm_p = os.path.normpath(p)
        if norm_p not in norm_allowed:
            # Check if it's under an allowed directory pattern
            in_allowed = False
            for a in norm_allowed:
                if norm_p.startswith(a + os.sep) or norm_p == a:
                    in_allowed = True
                    break
            if not in_allowed:
                violations.append(norm_p)

    if violations:
        return {
            "passed": False,
            "reason": "out-of-allow-list changes detected",
            "changed_count": len(changed_paths),
            "violations": violations[:5],
        }

    for untracked in untracked_paths:
        binary_reason = inspect_untracked_binary(worktree, untracked)
        if binary_reason:
            return {
                "passed": False,
                "reason": binary_reason,
                "changed_count": len(changed_paths),
            }

    # Check for binary/NUL diffs
    numstat = subprocess_adapter.run_command(
        cmd=["git", "diff", "--numstat", "--cached"],
        cwd=str(worktree), timeout=30, env=None, capture=True,
    )
    if numstat.returncode == 0:
        for line in numstat.stdout.splitlines():
            fields = line.split("\t")
            if len(fields) >= 3 and fields[0] == "-" and fields[1] == "-":
                return {
                    "passed": False,
                    "reason": f"binary diff detected: {fields[2]}",
                    "changed_count": len(changed_paths),
                }

    # Also check unstaged diffs for binary
    numstat_unstaged = subprocess_adapter.run_command(
        cmd=["git", "diff", "--numstat"],
        cwd=str(worktree), timeout=30, env=None, capture=True,
    )
    if numstat_unstaged.returncode == 0:
        for line in numstat_unstaged.stdout.splitlines():
            fields = line.split("\t")
            if len(fields) >= 3 and fields[0] == "-" and fields[1] == "-":
                return {
                    "passed": False,
                    "reason": f"binary diff detected: {fields[2]}",
                    "changed_count": len(changed_paths),
                }

    return {"passed": True, "changed_count": len(changed_paths)}


def inspect_untracked_binary(worktree: Path, relative_path: str) -> str | None:
    """Inspect untracked files directly because git diff --numstat omits them."""
    candidate = (worktree / relative_path).resolve()
    try:
        candidate.relative_to(worktree.resolve())
    except ValueError:
        return f"untracked path escapes worktree: {relative_path}"
    files: list[Path]
    if candidate.is_dir():
        files = [p for p in candidate.rglob("*") if p.is_file()]
    else:
        files = [candidate]
    for file_path in files:
        try:
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(8192)
                    if not chunk:
                        break
                    if b"\x00" in chunk:
                        return f"binary/NUL untracked file detected: {relative_path}"
        except OSError:
            return f"untracked file unreadable: {relative_path}"
    return None


# ---------------------------------------------------------------------------
# Acceptance execution
# ---------------------------------------------------------------------------

def run_acceptance(
    acceptance_body: str,
    worktree: Path,
    goal_id: str,
    run_id: str,
    subprocess_adapter: SubprocessAdapter,
) -> dict:
    """
    Execute acceptance block with /usr/bin/bash -e -u -o pipefail -s via stdin.
    Uses minimal allowlisted env. Returns metadata only.
    """
    sha256 = hashlib.sha256(acceptance_body.encode("utf-8")).hexdigest()
    t0 = time.monotonic()

    result = subprocess_adapter.run_command(
        cmd=["/usr/bin/bash", "-e", "-u", "-o", "pipefail", "-s"],
        cwd=str(worktree),
        timeout=120,
        env=_stage_env(goal_id, run_id, "acceptance", "controller"),
        capture=True,
        stdin_data=acceptance_body,
    )
    duration = time.monotonic() - t0

    return {
        "sha256": sha256,
        "exit_code": result.returncode,
        "duration_sec": round(duration, 2),
        "passed": result.returncode == 0,
    }


# ---------------------------------------------------------------------------
# Terminal result recording
# ---------------------------------------------------------------------------

def write_terminal_result(
    native_root: Path,
    goal_id: str,
    success: bool,
    stages: dict,
) -> None:
    """Write terminal result JSON atomically."""
    result = {
        "goal_id": goal_id,
        "success": success,
        "completed_at": datetime.now(UTC).isoformat(),
        "stages": stages,
    }
    result_path = native_root / "runs" / goal_id / "result.json"
    atomic_write_json(result_path, result)


def log_controller_warning(native_root: Path, summary: str, metadata: dict) -> None:
    """Write controller-level metadata-only evidence outside any goal run."""
    try:
        log_event(native_root / "controller-events.jsonl", "controller.warning", summary, metadata)
    except Exception:
        pass


def lock_warning_identity(lock_path: Path) -> str:
    """Stable metadata-only identity for lock warning dedupe."""
    try:
        stat = lock_path.stat()
        return f"{lock_path.name}:{stat.st_mtime_ns}:{stat.st_size}"
    except OSError:
        return f"{lock_path.name}:missing"


def log_controller_warning_once(native_root: Path, summary: str, metadata: dict, dedupe_key: str) -> None:
    """Write a controller warning once for a stable identity without reading lock content into events."""
    events_path = native_root / "controller-events.jsonl"
    try:
        if events_path.exists():
            for line in events_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except Exception:
                    continue
                if record.get("type") == "controller.warning" and record.get("metadata", {}).get("dedupe_key") == dedupe_key:
                    return
    except Exception:
        pass
    clean_metadata = dict(metadata)
    clean_metadata["dedupe_key"] = dedupe_key
    log_controller_warning(native_root, summary, clean_metadata)


# ---------------------------------------------------------------------------
# Finalize: terminal state + lock cleanup
# ---------------------------------------------------------------------------

def finalize_result(
    native_root: Path,
    goal_id: str,
    success: bool,
    stages: dict,
    pid: int,
    start_ticks: int | None,
) -> None:
    """Move goal to done/failed, write terminal result, then clean owned lock."""
    running_dir = native_root / "goals" / "running"
    target_dir = native_root / "goals" / ("done" if success else "failed")
    ensure_dir_durable(target_dir)
    running_path = running_dir / f"{goal_id}.md"

    # Move to final state
    if running_path.exists():
        final_path = target_dir / f"{goal_id}.md"
        try:
            os.replace(str(running_path), str(final_path))
            fsync_dir(target_dir)
            fsync_dir(running_dir)
        except OSError as exc:
            log_event(
                native_root / "runs" / goal_id / "events.jsonl",
                "terminal_move.failed",
                "Terminal state move failed; lock preserved for recovery",
                {"errno": exc.errno, "terminal_move_failed": True},
            )
            raise TerminalMoveError("terminal state move failed") from exc
    else:
        log_event(
            native_root / "runs" / goal_id / "events.jsonl",
            "terminal_move.failed",
            "Running goal markdown missing; lock preserved for recovery",
            {"terminal_move_failed": True},
        )
        raise TerminalMoveError("running goal markdown missing")

    # Write terminal result only after the terminal markdown transition succeeds.
    write_terminal_result(native_root, goal_id, success, stages)

    # Record terminal event
    events_path = native_root / "runs" / goal_id / "events.jsonl"
    log_event(
        events_path,
        "goal.completed" if success else "goal.failed",
        f"Goal {goal_id} {'completed' if success else 'failed'}",
        {"success": success},
    )

    # Remove lock only if still owned by this goal+pid+start_ticks
    lock_path = native_root / "controller.lock"
    cleanup_owned_lock(lock_path, goal_id, pid, start_ticks)


# ---------------------------------------------------------------------------
# Full goal lifecycle
# ---------------------------------------------------------------------------

def run_goal(
    goal_path: Path,
    goal_data: dict,
    native_root: Path,
    subprocess_adapter: SubprocessAdapter,
) -> tuple[bool, dict]:
    """Execute full goal lifecycle. Returns (success, stages_metadata)."""
    worktree = Path(goal_data["repo_worktree"])
    goal_id = goal_data["goal_id"]
    run_id = goal_id
    events_path = native_root / "runs" / goal_id / "events.jsonl"
    events_path.parent.mkdir(parents=True, exist_ok=True)
    stages: dict[str, Any] = {}

    worktree_ok, worktree_reason = validate_goal_worktree(worktree, native_root, subprocess_adapter)
    stages["worktree"] = {"passed": worktree_ok}
    if not worktree_ok:
        log_event(
            events_path,
            "worktree.failed",
            f"Worktree validation failed: {worktree_reason}",
            {"category": "worktree_validation_failed", "reason": worktree_reason},
        )
        return False, stages
    log_event(events_path, "agent.started", f"Starting goal {goal_id}", {"worktree": str(worktree)})

    prompt_goal_data = {**goal_data, "repo_worktree": str(worktree)}
    try:
        plan_prompt = build_prompt("plan", prompt_goal_data)
        code_prompt = build_prompt("code", prompt_goal_data)
    except ValueError as exc:
        stages["contract"] = {"passed": False, "reason": str(exc)}
        log_event(events_path, "contract.failed", "Goal contract exceeded prompt bounds", {})
        return False, stages

    # Step 1: Planner
    log_event(events_path, "model.requested", "Running planner (reviewer)", {})
    planner_result = run_hermes_planner(worktree, goal_id, run_id, plan_prompt, subprocess_adapter)
    stages["planner"] = {
        "exit_code": planner_result["exit_code"],
        "duration_sec": planner_result["duration_sec"],
        "stdout_bytes": planner_result["stdout_bytes"],
        "stderr_bytes": planner_result["stderr_bytes"],
        "marker_found": planner_result["marker_found"],
    }
    if not planner_result["passed"]:
        log_event(events_path, "planner.failed", "Planner did not approve", {})
        return False, stages

    log_event(events_path, "agent.started", "Planner approved", {"profile": "reviewer"})

    # Step 2: Coder
    log_event(events_path, "tool.started", "Running coder implementation", {})
    coder_result = run_hermes_coder(worktree, goal_id, run_id, code_prompt, subprocess_adapter)
    stages["coder"] = {
        "exit_code": coder_result["exit_code"],
        "duration_sec": coder_result["duration_sec"],
        "stdout_bytes": coder_result["stdout_bytes"],
        "stderr_bytes": coder_result["stderr_bytes"],
    }
    if not coder_result["passed"]:
        log_event(events_path, "coder.failed", "Coder failed", {})
        return False, stages

    # Step 3: Verify diff scope
    scope_result = check_git_scope(worktree, goal_data.get("allowed_files", []), subprocess_adapter)
    stages["scope_check"] = {
        "changed_count": scope_result.get("changed_count", 0),
        "passed": scope_result["passed"],
    }
    if not scope_result["passed"]:
        log_event(events_path, "scope.failed", f"Scope check failed: {scope_result.get('reason', 'unknown')}", {})
        return False, stages

    log_event(events_path, "tool.completed", "Coder produced valid diff", {"changed_count": scope_result["changed_count"]})

    # Step 4: Acceptance
    acceptance_body = goal_data.get("acceptance_body", "")
    if not acceptance_body:
        log_event(events_path, "acceptance.failed", "No acceptance block", {})
        return False, stages

    log_event(events_path, "acceptance.started", "Running deterministic acceptance", {})
    acceptance_result = run_acceptance(acceptance_body, worktree, goal_id, run_id, subprocess_adapter)
    stages["acceptance"] = {
        "sha256": acceptance_result["sha256"],
        "exit_code": acceptance_result["exit_code"],
        "duration_sec": acceptance_result["duration_sec"],
    }
    if not acceptance_result["passed"]:
        log_event(events_path, "acceptance.failed", "Acceptance failed", {"exit_code": acceptance_result["exit_code"]})
        return False, stages

    log_event(events_path, "acceptance.passed", "Acceptance passed", {"exit_code": 0})

    # Step 5: Final Review
    try:
        review_prompt = build_prompt(
            "review",
            prompt_goal_data,
            changed_count=scope_result.get("changed_count", 0),
            acceptance_exit=acceptance_result["exit_code"],
        )
    except ValueError as exc:
        stages["contract"] = {"passed": False, "reason": str(exc)}
        log_event(events_path, "contract.failed", "Goal contract exceeded prompt bounds", {})
        return False, stages
    log_event(events_path, "review.started", "Running final reviewer", {})
    reviewer_result = run_hermes_reviewer(worktree, goal_id, run_id, review_prompt, subprocess_adapter)
    stages["reviewer"] = {
        "exit_code": reviewer_result["exit_code"],
        "duration_sec": reviewer_result["duration_sec"],
        "stdout_bytes": reviewer_result["stdout_bytes"],
        "stderr_bytes": reviewer_result["stderr_bytes"],
        "marker_found": reviewer_result["marker_found"],
    }
    if not reviewer_result["passed"]:
        log_event(events_path, "review.failed", "Final review did not pass", {})
        return False, stages

    log_event(events_path, "review.passed", "Final review passed", {"profile": "reviewer"})
    return True, stages


# ---------------------------------------------------------------------------
# Self-test suite — fully synthetic, no model/network calls
# ---------------------------------------------------------------------------

class FakeSubprocess:
    """Injectable fake for self-tests. Configurable per-command responses."""

    def __init__(self) -> None:
        self.responses: dict[str, CmdResult] = {}
        self.calls: list[dict[str, Any]] = []

    def set_response(self, key: str, result: CmdResult) -> None:
        self.responses[key] = result

    def run_command(
        self,
        cmd: list[str],
        cwd: str,
        timeout: int,
        env: dict[str, str] | None,
        capture: bool,
        stdin_data: str | None = None,
    ) -> CmdResult:
        self.calls.append({
            "cmd": cmd,
            "cwd": cwd,
            "timeout": timeout,
            "env": env,
            "capture": capture,
            "stdin_data": stdin_data,
        })
        # Match on source tag or specific command patterns
        cmd_str = " ".join(cmd)
        for key, resp in self.responses.items():
            if key in cmd_str:
                return resp
        if cmd[:3] == ["git", "rev-parse", "--is-inside-work-tree"]:
            return CmdResult(returncode=0, stdout="true\n", stderr="", stdout_bytes=5, stderr_bytes=0)
        # Default: success with no output
        return CmdResult(returncode=0, stdout="", stderr="", stdout_bytes=0, stderr_bytes=0)


def _make_test_goal(
    worktree: str,
    title: str = "Test Goal",
    acceptance: str = 'echo "test"\nexit 0\n',
    allowed_files: list[str] | None = None,
) -> str:
    """Create a test goal markdown string."""
    if allowed_files is None:
        allowed_files = ["test.txt"]
    af_section = ""
    af_section = "\n## Allowed files\n\n" + "\n".join(f"- `{f}`" for f in allowed_files) + "\n"
    return f"""---
title: {title}
repo/workdir: {worktree}
dependencies:
---

{title} for canary validation.
{af_section}
## Acceptance

```bash
{acceptance}```
"""


def self_test() -> tuple[bool, str]:
    """Run synthetic self-test suite with full lifecycle and failure fixtures."""
    results: list[tuple[str, bool, str]] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        results.append((name, condition, detail))
        status = "PASS" if condition else "FAIL"
        print(f"  [{status}] {name}" + (f": {detail}" if detail and not condition else ""))

    print("[self-test] Starting synthetic canary suite...")

    with tempfile.TemporaryDirectory() as tmpdir:
        old_allowed_roots = os.environ.get("HERMES_NATIVE_ALLOWED_WORKTREE_ROOTS")
        os.environ["HERMES_NATIVE_ALLOWED_WORKTREE_ROOTS"] = tmpdir
        native_root = Path(tmpdir) / "runtime"
        for d in ("goals/ready", "goals/running", "goals/done", "goals/failed"):
            (native_root / d).mkdir(parents=True)

        # Create git repo for worktree
        worktree_dir = Path(tmpdir) / "worktree"
        worktree_dir.mkdir()
        subprocess.run(["git", "init"], cwd=worktree_dir, capture_output=True, timeout=10)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=worktree_dir, capture_output=True, timeout=5)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=worktree_dir, capture_output=True, timeout=5)
        (worktree_dir / "test.txt").write_text("initial\n")
        subprocess.run(["git", "add", "."], cwd=worktree_dir, capture_output=True, timeout=5)
        subprocess.run(["git", "commit", "-m", "init"], cwd=worktree_dir, capture_output=True, timeout=5)

        # ---- Test 1: Successful lifecycle ----
        print("\n  --- Test 1: Success lifecycle ---")
        goal_content = _make_test_goal(str(worktree_dir), allowed_files=["test.txt"])
        (native_root / "goals" / "ready" / "goal-success.md").write_text(goal_content)

        claimed_path, goal_data = claim_ready_goal(native_root)
        check("claim_success", claimed_path is not None)
        check("lock_created", (native_root / "controller.lock").exists())

        lock_live, lock_data = validate_lock(native_root / "controller.lock")
        check("lock_valid", lock_live)

        # Make a change in worktree
        (worktree_dir / "test.txt").write_text("modified\n")

        fake = FakeSubprocess()
        fake.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 14, 0))
        fake.set_response("mission-control-goal-code", CmdResult(0, "Code done\n", "", 10, 0))
        fake.set_response("mission-control-goal-review", CmdResult(0, f"{REVIEW_PASS_MARKER}\n", "", 12, 0))
        fake.set_response("git status", CmdResult(0, " M test.txt\x00", "", 14, 0))
        fake.set_response("git diff --numstat --cached", CmdResult(0, "", "", 0, 0))
        fake.set_response("git diff --numstat", CmdResult(0, "1\t1\ttest.txt\n", "", 15, 0))
        fake.set_response("/usr/bin/bash", CmdResult(0, "", "", 0, 0))

        if goal_data:
            goal_data["repo_worktree"] = str(worktree_dir)
            success, stages = run_goal(claimed_path, goal_data, native_root, fake)
            check("lifecycle_success", success)
            check("planner_marker", stages.get("planner", {}).get("marker_found") is True)
            check("reviewer_marker", stages.get("reviewer", {}).get("marker_found") is True)

            pid = os.getpid()
            start_ticks = get_process_start_ticks(pid)
            finalize_result(native_root, "goal-success", True, stages, pid, start_ticks)
            check("done_state", (native_root / "goals" / "done" / "goal-success.md").exists())
            check("result_json", (native_root / "runs" / "goal-success" / "result.json").exists())
            check("lock_cleaned", not (native_root / "controller.lock").exists())
            check("events_exist", (native_root / "runs" / "goal-success" / "events.jsonl").exists())

            # Verify no output leakage in events
            events_content = (native_root / "runs" / "goal-success" / "events.jsonl").read_text()
            check("no_stdout_leak", "Plan looks good" not in events_content)
            check("no_stderr_leak", "Code done" not in events_content)

        # ---- Test 2: Empty planner output fails ----
        print("\n  --- Test 2: Empty planner output fails ---")
        (native_root / "goals" / "ready" / "goal-empty-plan.md").write_text(
            _make_test_goal(str(worktree_dir), title="Empty Plan Goal")
        )
        claimed2, gd2 = claim_ready_goal(native_root)
        if claimed2 and gd2:
            gd2["repo_worktree"] = str(worktree_dir)
            fake2 = FakeSubprocess()
            fake2.set_response("mission-control-goal-plan", CmdResult(0, "", "", 0, 0))
            success2, stages2 = run_goal(claimed2, gd2, native_root, fake2)
            check("empty_planner_fails", not success2)
            pid2 = os.getpid()
            st2 = get_process_start_ticks(pid2)
            finalize_result(native_root, "goal-empty-plan", False, stages2, pid2, st2)

        # ---- Test 3: Invalid planner marker fails ----
        print("\n  --- Test 3: Invalid planner marker fails ---")
        (native_root / "goals" / "ready" / "goal-bad-marker.md").write_text(
            _make_test_goal(str(worktree_dir), title="Bad Marker Goal")
        )
        claimed3, gd3 = claim_ready_goal(native_root)
        if claimed3 and gd3:
            gd3["repo_worktree"] = str(worktree_dir)
            fake3 = FakeSubprocess()
            fake3.set_response("mission-control-goal-plan", CmdResult(0, f"Plan looks good. {PLAN_APPROVED_MARKER}\n", "", 33, 0))
            success3, _ = run_goal(claimed3, gd3, native_root, fake3)
            check("planner_prose_marker_fails", not success3)
            pid3 = os.getpid()
            st3 = get_process_start_ticks(pid3)
            finalize_result(native_root, "goal-bad-marker", False, {}, pid3, st3)

        # ---- Test 4: Coder empty diff fails ----
        print("\n  --- Test 4: Coder empty diff fails ---")
        (native_root / "goals" / "ready" / "goal-no-diff.md").write_text(
            _make_test_goal(str(worktree_dir), title="No Diff Goal")
        )
        claimed4, gd4 = claim_ready_goal(native_root)
        if claimed4 and gd4:
            gd4["repo_worktree"] = str(worktree_dir)
            fake4 = FakeSubprocess()
            fake4.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
            fake4.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
            fake4.set_response("git status", CmdResult(0, "", "", 0, 0))  # Empty diff
            success4, stages4 = run_goal(claimed4, gd4, native_root, fake4)
            check("empty_diff_fails", not success4)
            check("empty_diff_reason", stages4.get("scope_check", {}).get("passed") is False)
            pid4 = os.getpid()
            st4 = get_process_start_ticks(pid4)
            finalize_result(native_root, "goal-no-diff", False, stages4, pid4, st4)

        # ---- Test 5: Non-zero acceptance fails ----
        print("\n  --- Test 5: Non-zero acceptance fails ---")
        (native_root / "goals" / "ready" / "goal-bad-accept.md").write_text(
            _make_test_goal(str(worktree_dir), title="Bad Accept Goal", acceptance="exit 1\n", allowed_files=["test.txt"])
        )
        claimed5, gd5 = claim_ready_goal(native_root)
        if claimed5 and gd5:
            gd5["repo_worktree"] = str(worktree_dir)
            fake5 = FakeSubprocess()
            fake5.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
            fake5.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
            fake5.set_response("git status", CmdResult(0, " M test.txt\x00", "", 14, 0))
            fake5.set_response("git diff --numstat", CmdResult(0, "1\t1\ttest.txt\n", "", 15, 0))
            fake5.set_response("/usr/bin/bash", CmdResult(1, "", "error", 0, 5))
            success5, stages5 = run_goal(claimed5, gd5, native_root, fake5)
            check("bad_acceptance_fails", not success5)
            check("acceptance_exit_code", stages5.get("acceptance", {}).get("exit_code") == 1)
            pid5 = os.getpid()
            st5 = get_process_start_ticks(pid5)
            finalize_result(native_root, "goal-bad-accept", False, stages5, pid5, st5)

        # ---- Test 6: Stale lock and PID-reuse mismatch ----
        print("\n  --- Test 6: Stale lock + PID reuse mismatch ---")
        # Create a lock with a dead PID
        stale_lock = native_root / "controller.lock"
        stale_lock.parent.mkdir(parents=True, exist_ok=True)
        # Use O_EXCL-safe creation for the stale lock
        if stale_lock.exists():
            stale_lock.unlink()
        stale_payload = json.dumps({"goal_id": "stale-goal", "pid": 999999, "proc_start_ticks": 0}).encode()
        fd = os.open(str(stale_lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, stale_payload)
        os.close(fd)

        live, data = validate_lock(stale_lock)
        check("stale_lock_rejected", not live)

        # PID reuse: lock with our PID but wrong start_ticks
        stale_lock.unlink()
        our_pid = os.getpid()
        our_ticks = get_process_start_ticks(our_pid)
        wrong_payload = json.dumps({"goal_id": "reuse-goal", "pid": our_pid, "proc_start_ticks": our_ticks + 99999}).encode()
        fd = os.open(str(stale_lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, wrong_payload)
        os.close(fd)

        live_reuse, _ = validate_lock(stale_lock)
        check("pid_reuse_mismatch_rejected", not live_reuse)
        stale_lock.unlink(missing_ok=True)

        # ---- Test 7: Existing lock is not overwritten (O_EXCL) ----
        print("\n  --- Test 7: O_EXCL prevents lock overwrite ---")
        ok1 = create_controller_lock(stale_lock, "first-goal", 1, 100)
        check("first_lock_created", ok1)
        ok2 = create_controller_lock(stale_lock, "second-goal", 2, 200)
        check("second_lock_blocked", not ok2)
        # Verify first lock data preserved
        with open(stale_lock) as f:
            preserved = json.load(f)
        check("first_lock_preserved", preserved["goal_id"] == "first-goal")
        stale_lock.unlink(missing_ok=True)

        # ---- Test 7b: Malformed lock blocks claims and dedupes warnings ----
        print("\n  --- Test 7b: Malformed lock fail-closed ---")
        malformed_lock = native_root / "controller.lock"
        malformed_lock.write_text("{not-json", encoding="utf-8")
        (native_root / "goals" / "ready" / "blocked-by-bad-lock.md").write_text(
            _make_test_goal(str(worktree_dir), title="Blocked By Bad Lock")
        )
        bad_lock_claim1, _ = claim_ready_goal(native_root)
        bad_lock_claim2, _ = claim_ready_goal(native_root)
        controller_events = (native_root / "controller-events.jsonl").read_text(encoding="utf-8")
        check("malformed_lock_blocks_claim", bad_lock_claim1 is None and bad_lock_claim2 is None)
        check("malformed_lock_remains_present", malformed_lock.exists())
        check("malformed_lock_goal_remains_ready", (native_root / "goals" / "ready" / "blocked-by-bad-lock.md").exists())
        check("malformed_lock_warning_visible", "lock_invalid" in controller_events and "{not-json" not in controller_events)
        check("malformed_lock_warning_deduped", controller_events.count("lock-invalid:controller.lock") == 1)
        malformed_lock.unlink(missing_ok=True)
        (native_root / "goals" / "ready" / "blocked-by-bad-lock.md").unlink(missing_ok=True)

        # ---- Test 7bb: /proc start tick failure blocks claim ----
        print("\n  --- Test 7bb: /proc start tick fail-closed ---")
        (native_root / "goals" / "ready" / "proc-start-failure.md").write_text(
            _make_test_goal(str(worktree_dir), title="Proc Start Failure")
        )
        original_get_start_ticks = get_process_start_ticks
        try:
            globals()["get_process_start_ticks"] = lambda _pid: None
            proc_fail_claim, _ = claim_ready_goal(native_root)
        finally:
            globals()["get_process_start_ticks"] = original_get_start_ticks
        check("proc_start_failure_not_claimed", proc_fail_claim is None)
        check("proc_start_failure_ready_remains", (native_root / "goals" / "ready" / "proc-start-failure.md").exists())
        check("proc_start_failure_no_lock", not (native_root / "controller.lock").exists())
        (native_root / "goals" / "ready" / "proc-start-failure.md").unlink(missing_ok=True)

        zero_tick_lock = native_root / "controller.lock"
        zero_tick_lock.write_text(json.dumps({"goal_id": "zero-tick-owner", "pid": os.getpid(), "proc_start_ticks": 0}), encoding="utf-8")
        (native_root / "goals" / "ready" / "blocked-by-zero-tick-lock.md").write_text(
            _make_test_goal(str(worktree_dir), title="Blocked By Zero Tick Lock")
        )
        zero_tick_claim, _ = claim_ready_goal(native_root)
        check("zero_tick_lock_blocks_claim", zero_tick_claim is None)
        check("zero_tick_lock_remains_present", zero_tick_lock.exists())
        check("zero_tick_goal_remains_ready", (native_root / "goals" / "ready" / "blocked-by-zero-tick-lock.md").exists())
        zero_tick_lock.unlink(missing_ok=True)
        (native_root / "goals" / "ready" / "blocked-by-zero-tick-lock.md").unlink(missing_ok=True)

        # ---- Test 7c: Lock exists before ready-to-running move ----
        print("\n  --- Test 7c: Lock-before-move ordering ---")
        (native_root / "goals" / "ready" / "lock-before-move.md").write_text(
            _make_test_goal(str(worktree_dir), title="Lock Before Move")
        )
        original_replace = os.replace
        observed_lock_before_move = {"value": False}

        def observing_replace(src: str, dst: str) -> None:
            if src.endswith("goals/ready/lock-before-move.md") and dst.endswith("goals/running/lock-before-move.md"):
                observed_lock_before_move["value"] = (native_root / "controller.lock").exists()
            original_replace(src, dst)

        os.replace = observing_replace
        try:
            lbm_claim, lbm_goal = claim_ready_goal(native_root)
        finally:
            os.replace = original_replace
        check("lock_exists_before_move", observed_lock_before_move["value"])
        check("lock_before_move_claimed", lbm_claim is not None and lbm_goal is not None)
        if lbm_claim:
            finalize_result(native_root, "lock-before-move", False, {}, os.getpid(), get_process_start_ticks(os.getpid()))

        # ---- Test 7d: Move failure cleans only owned lock ----
        print("\n  --- Test 7d: Move failure owned-lock cleanup ---")
        (native_root / "goals" / "ready" / "move-fails.md").write_text(
            _make_test_goal(str(worktree_dir), title="Move Fails")
        )

        def failing_replace(src: str, dst: str) -> None:
            if src.endswith("goals/ready/move-fails.md") and dst.endswith("goals/running/move-fails.md"):
                raise OSError(13, "fixture move failure")
            original_replace(src, dst)

        os.replace = failing_replace
        try:
            move_fail_claim, _ = claim_ready_goal(native_root)
        finally:
            os.replace = original_replace
        check("move_failure_not_claimed", move_fail_claim is None)
        check("move_failure_owned_lock_cleaned", not (native_root / "controller.lock").exists())
        check("move_failure_goal_still_ready", (native_root / "goals" / "ready" / "move-fails.md").exists())
        (native_root / "goals" / "ready" / "move-fails.md").unlink(missing_ok=True)

        # ---- Test 7e: Orphan running recovery and lock preservation ----
        print("\n  --- Test 7e: Orphan running recovery ---")
        (native_root / "goals" / "running" / "dead-orphan.md").write_text(
            _make_test_goal(str(worktree_dir), title="Dead Orphan")
        )
        recovered_claim, recovered_goal = claim_ready_goal(native_root)
        check("dead_orphan_recovered_then_claimed", recovered_claim is not None and recovered_goal is not None and recovered_goal.get("goal_id") == "dead-orphan")
        orphan_events = (native_root / "runs" / "dead-orphan" / "events.jsonl").read_text(encoding="utf-8")
        check("dead_orphan_non_terminal_evidence", "running-to-ready" in orphan_events and '"terminal":false' in orphan_events)
        if recovered_claim:
            finalize_result(native_root, "dead-orphan", False, {}, os.getpid(), get_process_start_ticks(os.getpid()))

        (native_root / "goals" / "running" / "mismatched-result-orphan.md").write_text(
            _make_test_goal(str(worktree_dir), title="Mismatched Result Orphan")
        )
        atomic_write_json(native_root / "runs" / "mismatched-result-orphan" / "result.json", {
            "goal_id": "other-goal",
            "success": True,
        })
        mismatch_claim, mismatch_goal = claim_ready_goal(native_root)
        check(
            "mismatched_result_orphan_recovered_then_claimed",
            mismatch_claim is not None and mismatch_goal is not None and mismatch_goal.get("goal_id") == "mismatched-result-orphan",
        )
        mismatch_events = (native_root / "runs" / "mismatched-result-orphan" / "events.jsonl").read_text(encoding="utf-8")
        check("mismatched_result_orphan_non_terminal_evidence", "running-to-ready" in mismatch_events and '"terminal":false' in mismatch_events)
        if mismatch_claim:
            finalize_result(native_root, "mismatched-result-orphan", False, {}, os.getpid(), get_process_start_ticks(os.getpid()))

        (native_root / "goals" / "running" / "preserve-live.md").write_text(
            _make_test_goal(str(worktree_dir), title="Preserve Live")
        )
        create_controller_lock(native_root / "controller.lock", "live-owner", os.getpid(), get_process_start_ticks(os.getpid()))
        live_preserve_claim, _ = claim_ready_goal(native_root)
        check("live_lock_blocks_orphan_recovery", live_preserve_claim is None and (native_root / "goals" / "running" / "preserve-live.md").exists())
        cleanup_owned_lock(native_root / "controller.lock", "live-owner", os.getpid(), get_process_start_ticks(os.getpid()))
        (native_root / "goals" / "running" / "preserve-live.md").unlink(missing_ok=True)

        (native_root / "goals" / "running" / "preserve-unknown.md").write_text(
            _make_test_goal(str(worktree_dir), title="Preserve Unknown")
        )
        (native_root / "controller.lock").write_text("{not-json", encoding="utf-8")
        unknown_preserve_claim, _ = claim_ready_goal(native_root)
        check("unknown_lock_blocks_orphan_recovery", unknown_preserve_claim is None and (native_root / "goals" / "running" / "preserve-unknown.md").exists())
        (native_root / "controller.lock").unlink(missing_ok=True)
        (native_root / "goals" / "running" / "preserve-unknown.md").unlink(missing_ok=True)

        # ---- Test 8: Out-of-allow-list diff fails ----
        print("\n  --- Test 8: Out-of-allow-list diff fails ---")
        (native_root / "goals" / "ready" / "goal-scope-escape.md").write_text(
            _make_test_goal(str(worktree_dir), title="Scope Escape Goal", allowed_files=["allowed.txt"])
        )
        claimed8, gd8 = claim_ready_goal(native_root)
        if claimed8 and gd8:
            gd8["repo_worktree"] = str(worktree_dir)
            fake8 = FakeSubprocess()
            fake8.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
            fake8.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
            fake8.set_response("git status", CmdResult(0, " M forbidden.txt\x00", "", 18, 0))
            fake8.set_response("git diff --numstat", CmdResult(0, "1\t1\tforbidden.txt\n", "", 20, 0))
            success8, stages8 = run_goal(claimed8, gd8, native_root, fake8)
            check("scope_escape_fails", not success8)
            pid8 = os.getpid()
            st8 = get_process_start_ticks(pid8)
            finalize_result(native_root, "goal-scope-escape", False, stages8, pid8, st8)

        # ---- Test 9: Binary diff fails ----
        print("\n  --- Test 9: Binary diff fails ---")
        (native_root / "goals" / "ready" / "goal-binary.md").write_text(
            _make_test_goal(str(worktree_dir), title="Binary Goal", allowed_files=["image.png"])
        )
        claimed9, gd9 = claim_ready_goal(native_root)
        if claimed9 and gd9:
            gd9["repo_worktree"] = str(worktree_dir)
            fake9 = FakeSubprocess()
            fake9.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
            fake9.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
            fake9.set_response("git status", CmdResult(0, " M image.png\x00", "", 14, 0))
            fake9.set_response("git diff --numstat --cached", CmdResult(0, "-\t-\timage.png\n", "", 15, 0))
            success9, stages9 = run_goal(claimed9, gd9, native_root, fake9)
            check("binary_diff_fails", not success9)
            pid9 = os.getpid()
            st9 = get_process_start_ticks(pid9)
            finalize_result(native_root, "goal-binary", False, stages9, pid9, st9)

        # ---- Test 10: Reviewer rejection/empty output fails ----
        print("\n  --- Test 10: Reviewer rejection fails ---")
        (native_root / "goals" / "ready" / "goal-review-fail.md").write_text(
            _make_test_goal(str(worktree_dir), title="Review Fail Goal", allowed_files=["test.txt"])
        )
        claimed10, gd10 = claim_ready_goal(native_root)
        if claimed10 and gd10:
            gd10["repo_worktree"] = str(worktree_dir)
            fake10 = FakeSubprocess()
            fake10.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
            fake10.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
            fake10.set_response("git status", CmdResult(0, " M test.txt\x00", "", 14, 0))
            fake10.set_response("git diff --numstat", CmdResult(0, "1\t1\ttest.txt\n", "", 15, 0))
            fake10.set_response("/usr/bin/bash", CmdResult(0, "", "", 0, 0))
            fake10.set_response("mission-control-goal-review", CmdResult(0, f"Looks correct. {REVIEW_PASS_MARKER}\n", "", 27, 0))
            success10, stages10 = run_goal(claimed10, gd10, native_root, fake10)
            check("reviewer_prose_marker_fails", not success10)
            check("reviewer_marker_missing", stages10.get("reviewer", {}).get("marker_found") is False)
            pid10 = os.getpid()
            st10 = get_process_start_ticks(pid10)
            finalize_result(native_root, "goal-review-fail", False, stages10, pid10, st10)

        # ---- Test 11: Reviewer empty output fails ----
        print("\n  --- Test 11: Reviewer empty output fails ---")
        (native_root / "goals" / "ready" / "goal-review-empty.md").write_text(
            _make_test_goal(str(worktree_dir), title="Review Empty Goal", allowed_files=["test.txt"])
        )
        claimed11, gd11 = claim_ready_goal(native_root)
        if claimed11 and gd11:
            gd11["repo_worktree"] = str(worktree_dir)
            fake11 = FakeSubprocess()
            fake11.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
            fake11.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
            fake11.set_response("git status", CmdResult(0, " M test.txt\x00", "", 14, 0))
            fake11.set_response("git diff --numstat", CmdResult(0, "1\t1\ttest.txt\n", "", 15, 0))
            fake11.set_response("/usr/bin/bash", CmdResult(0, "", "", 0, 0))
            fake11.set_response("mission-control-goal-review", CmdResult(0, "", "", 0, 0))
            success11, _ = run_goal(claimed11, gd11, native_root, fake11)
            check("reviewer_empty_fails", not success11)
            pid11 = os.getpid()
            st11 = get_process_start_ticks(pid11)
            finalize_result(native_root, "goal-review-empty", False, {}, pid11, st11)

        # ---- Test 12: Native root isolation ----
        print("\n  --- Test 12: Native root isolation ---")
        other_root = Path(tmpdir) / "other-runtime"
        for d in ("goals/ready", "goals/running", "goals/done", "goals/failed"):
            (other_root / d).mkdir(parents=True)
        (other_root / "goals" / "ready" / "goal-iso.md").write_text(
            _make_test_goal(str(worktree_dir), title="Isolation Goal")
        )
        claimed12, gd12 = claim_ready_goal(other_root)
        check("isolation_separate_root", claimed12 is not None)
        if claimed12:
            check("isolation_in_other_root", str(claimed12).startswith(str(other_root)))
            lock12 = other_root / "controller.lock"
            check("isolation_lock_in_other", lock12.exists())
            lock12.unlink(missing_ok=True)

        # ---- Test 13: Dependency contract done/result releases child only ----
        print("\n  --- Test 13: Dependency resolution ---")
        (native_root / "goals" / "ready" / "child-waiting.md").write_text(
            _make_test_goal(str(worktree_dir), title="Child Waiting").replace("dependencies:\n", "dependencies: missing-parent\n")
        )
        waiting_path, _ = claim_ready_goal(native_root)
        check("missing_parent_does_not_claim", waiting_path is None)
        (native_root / "goals" / "ready" / "child-waiting.md").unlink(missing_ok=True)

        (native_root / "goals" / "failed" / "failed-parent.md").write_text(_make_test_goal(str(worktree_dir), title="Failed Parent"))
        write_terminal_result(native_root, "failed-parent", False, {})
        (native_root / "goals" / "ready" / "child-failed-parent.md").write_text(
            _make_test_goal(str(worktree_dir), title="Child Failed Parent").replace("dependencies:\n", "dependencies: failed-parent\n")
        )
        failed_parent_path, _ = claim_ready_goal(native_root)
        check("failed_parent_does_not_claim", failed_parent_path is None)
        (native_root / "goals" / "ready" / "child-failed-parent.md").unlink(missing_ok=True)

        (native_root / "goals" / "done" / "done-parent.md").write_text(_make_test_goal(str(worktree_dir), title="Done Parent"))
        write_terminal_result(native_root, "done-parent", True, {})
        (native_root / "goals" / "ready" / "child-done-parent.md").write_text(
            _make_test_goal(str(worktree_dir), title="Child Done Parent").replace("dependencies:\n", "dependencies: done-parent\n")
        )
        child_path, child_data = claim_ready_goal(native_root)
        check("done_parent_releases_child", child_path is not None and child_data is not None)
        if child_path:
            finalize_result(native_root, "child-done-parent", False, {}, os.getpid(), get_process_start_ticks(os.getpid()))

        (native_root / "goals" / "done" / "mismatch-parent.md").write_text(_make_test_goal(str(worktree_dir), title="Mismatch Parent"))
        atomic_write_json(native_root / "runs" / "mismatch-parent" / "result.json", {
            "goal_id": "other-parent",
            "success": True,
            "completed_at": datetime.now(UTC).isoformat(),
            "stages": {},
        })
        (native_root / "goals" / "ready" / "child-mismatch-parent.md").write_text(
            _make_test_goal(str(worktree_dir), title="Child Mismatch Parent").replace("dependencies:\n", "dependencies: mismatch-parent\n")
        )
        mismatch_parent_path, _ = claim_ready_goal(native_root)
        check("mismatched_parent_result_does_not_claim", mismatch_parent_path is None)
        (native_root / "goals" / "ready" / "child-mismatch-parent.md").unlink(missing_ok=True)

        # ---- Test 13b: Blocked first ready goal does not idle queue ----
        print("\n  --- Test 13b: Dependency-blocked ready skip ---")
        (native_root / "goals" / "ready" / "aaa-blocked-child.md").write_text(
            _make_test_goal(str(worktree_dir), title="Blocked Child").replace("dependencies:\n", "dependencies: missing-parent\n")
        )
        (native_root / "goals" / "ready" / "zzz-runnable-child.md").write_text(
            _make_test_goal(str(worktree_dir), title="Runnable Child")
        )
        runnable_path, runnable_goal = claim_ready_goal(native_root)
        check("blocked_first_skips_to_runnable", runnable_path is not None and runnable_path.name == "zzz-runnable-child.md")
        check("blocked_goal_remains_ready", (native_root / "goals" / "ready" / "aaa-blocked-child.md").exists())
        check("blocked_goal_not_terminal", not (native_root / "runs" / "aaa-blocked-child" / "result.json").exists())
        blocked_events = (native_root / "runs" / "aaa-blocked-child" / "events.jsonl").read_text()
        check("blocked_goal_non_terminal_event", "goal.blocked" in blocked_events and "goal.failed" not in blocked_events and "goal.completed" not in blocked_events)
        check("blocked_goal_dependency_metadata", "missing-parent" in blocked_events and '"terminal":false' in blocked_events)
        if runnable_path and runnable_goal:
            finalize_result(native_root, "zzz-runnable-child", False, {}, os.getpid(), get_process_start_ticks(os.getpid()))
        (native_root / "goals" / "ready" / "aaa-blocked-child.md").unlink(missing_ok=True)

        # ---- Test 14: Real untracked binary/NUL file is rejected ----
        print("\n  --- Test 14: Real untracked binary rejection ---")
        bin_repo = Path(tmpdir) / "binary-repo"
        bin_repo.mkdir()
        subprocess.run(["git", "init"], cwd=bin_repo, capture_output=True, timeout=10)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=bin_repo, capture_output=True, timeout=5)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=bin_repo, capture_output=True, timeout=5)
        (bin_repo / "tracked.txt").write_text("initial\n")
        subprocess.run(["git", "add", "."], cwd=bin_repo, capture_output=True, timeout=5)
        subprocess.run(["git", "commit", "-m", "init"], cwd=bin_repo, capture_output=True, timeout=5)
        (bin_repo / "binary.dat").write_bytes(b"abc\x00def")
        binary_scope = check_git_scope(bin_repo, ["binary.dat"], RealSubprocess())
        check("real_untracked_binary_fails", binary_scope.get("passed") is False and "binary" in binary_scope.get("reason", ""))

        # ---- Test 15: Malformed ready goal is quarantined deterministically ----
        print("\n  --- Test 15: Malformed ready quarantine ---")
        (native_root / "goals" / "ready" / "bad-ready.md").write_text("not a valid goal")
        bad_claim, _ = claim_ready_goal(native_root)
        check("malformed_not_claimed", bad_claim is None)
        check("malformed_moved_failed", (native_root / "goals" / "failed" / "bad-ready.md").exists())
        check("malformed_result_written", (native_root / "runs" / "bad-ready" / "result.json").exists())

        # ---- Test 15b: Missing closing frontmatter fence is quarantined pre-model ----
        print("\n  --- Test 15b: Missing frontmatter close quarantine ---")
        plausible_unclosed_goal = _make_test_goal(
            str(worktree_dir),
            title="Unclosed Frontmatter Goal",
            allowed_files=["test.txt"],
        ).replace("---\n\nUnclosed Frontmatter Goal", "\n\nUnclosed Frontmatter Goal", 1)
        unclosed_path = native_root / "goals" / "ready" / "unclosed-frontmatter.md"
        unclosed_path.write_text(plausible_unclosed_goal)
        unclosed_claim, _ = claim_ready_goal(native_root)
        check("unclosed_frontmatter_not_claimed", unclosed_claim is None)
        check("unclosed_frontmatter_left_ready", not unclosed_path.exists())
        check("unclosed_frontmatter_moved_failed", (native_root / "goals" / "failed" / "unclosed-frontmatter.md").exists())
        unclosed_result = json.loads((native_root / "runs" / "unclosed-frontmatter" / "result.json").read_text())
        unclosed_events = (native_root / "runs" / "unclosed-frontmatter" / "events.jsonl").read_text()
        check("unclosed_frontmatter_metadata_only_result", unclosed_result.get("stages", {}).get("claim", {}).get("reason") == "goal missing closing frontmatter fence")
        check("unclosed_frontmatter_terminal_failed", "goal.failed" in unclosed_events)
        check("unclosed_frontmatter_zero_model_calls", "model.requested" not in unclosed_events and "planner" not in unclosed_result.get("stages", {}))

        # ---- Test 16: Stale lock recovery before claim ----
        print("\n  --- Test 16: Stale lock recovery before claim ---")
        stale_lock = native_root / "controller.lock"
        stale_lock.unlink(missing_ok=True)
        stale_lock.write_text(json.dumps({"goal_id": "dead-lock", "pid": 999999, "proc_start_ticks": 1}))
        (native_root / "goals" / "ready" / "after-stale.md").write_text(_make_test_goal(str(worktree_dir), title="After Stale"))
        stale_claim, stale_goal = claim_ready_goal(native_root)
        check("stale_lock_removed_and_claimed", stale_claim is not None and stale_goal is not None)
        stale_events = (native_root / "runs" / "dead-lock" / "events.jsonl").read_text()
        check("stale_recovery_not_goal_failed", "goal.failed" not in stale_events and "controller.lock_recovered" in stale_events)
        if stale_claim:
            finalize_result(native_root, "after-stale", False, {}, os.getpid(), get_process_start_ticks(os.getpid()))

        # ---- Test 17: Terminal move failure preserves lock and avoids terminal event ----
        print("\n  --- Test 17: Terminal move failure fails closed ---")
        (native_root / "goals" / "running" / "move-fail.md").write_text(_make_test_goal(str(worktree_dir), title="Move Fail"))
        create_controller_lock(native_root / "controller.lock", "move-fail", os.getpid(), get_process_start_ticks(os.getpid()))
        original_replace = os.replace
        def failing_replace(src: str, dst: str) -> None:
            if src.endswith("move-fail.md"):
                raise OSError(5, "forced")
            original_replace(src, dst)
        os.replace = failing_replace
        try:
            try:
                finalize_result(native_root, "move-fail", True, {}, os.getpid(), get_process_start_ticks(os.getpid()))
                terminal_failed_closed = False
            except TerminalMoveError:
                terminal_failed_closed = True
        finally:
            os.replace = original_replace
        move_fail_events = (native_root / "runs" / "move-fail" / "events.jsonl").read_text()
        check("terminal_move_raises", terminal_failed_closed)
        check("terminal_move_running_preserved", (native_root / "goals" / "running" / "move-fail.md").exists())
        check("terminal_move_lock_preserved", (native_root / "controller.lock").exists())
        check("terminal_event_not_emitted", "goal.completed" not in move_fail_events)
        check("terminal_result_not_written_on_move_failure", not (native_root / "runs" / "move-fail" / "result.json").exists())
        (native_root / "controller.lock").unlink(missing_ok=True)
        (native_root / "goals" / "running" / "move-fail.md").unlink(missing_ok=True)

        # ---- Test 18: Worktree validation rejects non-git path before model calls ----
        print("\n  --- Test 18: Worktree validation before model ---")
        nongit_dir = Path(tmpdir) / "nongit"
        nongit_dir.mkdir()
        fake_pre_model = FakeSubprocess()
        fake_pre_model.set_response("git rev-parse --is-inside-work-tree", CmdResult(1, "false\n", "", 6, 0))
        success_pre, stages_pre = run_goal(
            native_root / "goals" / "running" / "no-such.md",
            {
                "goal_id": "no-git",
                "title": "No Git",
                "repo_worktree": str(nongit_dir),
                "allowed_files": ["x.txt"],
                "acceptance_body": "exit 0\n",
                "goal_contract": "must not invoke model",
            },
            native_root,
            fake_pre_model,
        )
        model_calls = [call for call in fake_pre_model.calls if "hermes" in call["cmd"]]
        check("nongit_worktree_fails", not success_pre and stages_pre.get("worktree", {}).get("passed") is False)
        check("nongit_no_model_calls", len(model_calls) == 0)

        sensitive_worktree_marker = "SENSITIVE_REJECTED_WORKTREE_MARKER"
        rejected_worktree = Path(tmpdir) / sensitive_worktree_marker
        rejected_worktree.mkdir()
        fake_sensitive_worktree = FakeSubprocess()
        fake_sensitive_worktree.set_response("git rev-parse --is-inside-work-tree", CmdResult(1, "false\n", "", 6, 0))
        rejected_success, rejected_stages = run_goal(
            native_root / "goals" / "running" / "rejected-worktree.md",
            {
                "goal_id": "rejected-worktree",
                "title": "Rejected Worktree",
                "repo_worktree": str(rejected_worktree),
                "allowed_files": ["x.txt"],
                "acceptance_body": "exit 0\n",
                "goal_contract": "reject before leaking worktree",
            },
            native_root,
            fake_sensitive_worktree,
        )
        rejected_events = (native_root / "runs" / "rejected-worktree" / "events.jsonl").read_text(encoding="utf-8")
        rejected_result_blob = json.dumps({"success": rejected_success, "stages": rejected_stages}, sort_keys=True)
        check("rejected_worktree_fails", not rejected_success)
        check("rejected_worktree_marker_absent_from_events_results", sensitive_worktree_marker not in rejected_events and sensitive_worktree_marker not in rejected_result_blob)

        # ---- Test 18b: Forbidden worktree rejects before filesystem/Git inspection ----
        print("\n  --- Test 18b: Forbidden worktree preflight order ---")
        forbidden_probe = FORBIDDEN_WORKTREE_ROOTS[0] / "definitely-not-inspected"
        fake_forbidden = FakeSubprocess()
        original_exists = Path.exists
        original_is_dir = Path.is_dir
        original_resolve = Path.resolve
        forbidden_inspection_touched = False

        def forbidden_inspection_guard(self: Path, *args: Any, **kwargs: Any) -> Any:
            nonlocal forbidden_inspection_touched
            if os.fspath(self).startswith(os.fspath(FORBIDDEN_WORKTREE_ROOTS[0])):
                forbidden_inspection_touched = True
                raise AssertionError("forbidden path filesystem inspection")
            if kwargs or args:
                return original_resolve(self, *args, **kwargs)
            return original_resolve(self)

        def forbidden_exists_guard(self: Path) -> bool:
            nonlocal forbidden_inspection_touched
            if os.fspath(self).startswith(os.fspath(FORBIDDEN_WORKTREE_ROOTS[0])):
                forbidden_inspection_touched = True
                raise AssertionError("forbidden path exists inspection")
            return original_exists(self)

        def forbidden_is_dir_guard(self: Path) -> bool:
            nonlocal forbidden_inspection_touched
            if os.fspath(self).startswith(os.fspath(FORBIDDEN_WORKTREE_ROOTS[0])):
                forbidden_inspection_touched = True
                raise AssertionError("forbidden path is_dir inspection")
            return original_is_dir(self)

        try:
            Path.resolve = forbidden_inspection_guard  # type: ignore[method-assign]
            Path.exists = forbidden_exists_guard  # type: ignore[method-assign]
            Path.is_dir = forbidden_is_dir_guard  # type: ignore[method-assign]
            forbidden_ok, forbidden_reason = validate_goal_worktree(forbidden_probe, native_root, fake_forbidden)
        except AssertionError:
            forbidden_ok, forbidden_reason = True, "inspected forbidden path"
        finally:
            Path.resolve = original_resolve  # type: ignore[method-assign]
            Path.exists = original_exists  # type: ignore[method-assign]
            Path.is_dir = original_is_dir  # type: ignore[method-assign]
        check("forbidden_worktree_rejected_before_fs", not forbidden_ok and forbidden_reason == "worktree path is forbidden")
        check("forbidden_worktree_no_fs_inspection", not forbidden_inspection_touched)
        check("forbidden_worktree_git_untouched", fake_forbidden.calls == [])

        # ---- Test 19: Prompt is delivered only through stdin ----
        print("\n  --- Test 19: Prompt stdin-only contract ---")
        sensitive_marker = "SENSITIVE_PROMPT_MARKER_9f8e7d6c"
        sensitive_acceptance_marker = "SENSITIVE_ACCEPTANCE_MARKER_4c3b2a10"
        acceptance_contract_body = f'grep -q "HERMES_NATIVE_CANARY_OK" test.txt\nprintf "%s\\n" "{sensitive_acceptance_marker}" >/dev/null\n'
        fake_acceptance_only = FakeSubprocess()
        acceptance_only_result = run_acceptance(
            acceptance_contract_body,
            worktree_dir,
            "acceptance-contract-goal",
            "acceptance-contract-run",
            fake_acceptance_only,
        )
        acceptance_only_calls = [call for call in fake_acceptance_only.calls if call["cmd"][:1] == ["/usr/bin/bash"]]
        acceptance_only_call = acceptance_only_calls[0] if acceptance_only_calls else {}
        check("acceptance_bash_argv_exact", acceptance_only_call.get("cmd") == ["/usr/bin/bash", "-e", "-u", "-o", "pipefail", "-s"])
        check("acceptance_body_delivered_via_stdin", acceptance_only_call.get("stdin_data") == acceptance_contract_body)
        check(
            "acceptance_marker_absent_from_argv_env_result",
            sensitive_acceptance_marker not in json.dumps(acceptance_only_call.get("cmd"))
            and sensitive_acceptance_marker not in json.dumps(acceptance_only_call.get("env"), sort_keys=True)
            and sensitive_acceptance_marker not in json.dumps(acceptance_only_result, sort_keys=True),
        )
        check("acceptance_timeout_cwd_capture_preserved", acceptance_only_call.get("timeout") == 120 and acceptance_only_call.get("cwd") == str(worktree_dir) and acceptance_only_call.get("capture") is True)
        contract_goal = parse_goal_markdown(_make_test_goal(
            str(worktree_dir),
            title="Contract Goal",
            acceptance=acceptance_contract_body,
            allowed_files=["test.txt"],
        ).replace("Contract Goal for canary validation.", f"Write HERMES_NATIVE_CANARY_OK into test.txt. {sensitive_marker}"))
        contract_goal["goal_id"] = "contract-goal"
        (worktree_dir / "test.txt").write_text("HERMES_NATIVE_CANARY_OK\n")
        fake_contract = FakeSubprocess()
        fake_contract.set_response("mission-control-goal-plan", CmdResult(0, f"{PLAN_APPROVED_MARKER}\n", "", 15, 0))
        fake_contract.set_response("mission-control-goal-code", CmdResult(0, "done\n", "", 5, 0))
        fake_contract.set_response("git status", CmdResult(0, " M test.txt\x00", "", 14, 0))
        fake_contract.set_response("git diff --numstat", CmdResult(0, "1\t1\ttest.txt\n", "", 15, 0))
        fake_contract.set_response("/usr/bin/bash", CmdResult(0, "", "", 0, 0))
        fake_contract.set_response("mission-control-goal-review", CmdResult(0, f"{REVIEW_PASS_MARKER}\n", "", 13, 0))
        run_goal(native_root / "goals" / "running" / "contract-goal.md", contract_goal, native_root, fake_contract)
        hermes_calls = [call for call in fake_contract.calls if call["cmd"][:1] == ["hermes"]]
        acceptance_calls = [call for call in fake_contract.calls if call["cmd"][:1] == ["/usr/bin/bash"]]
        argv_blob = json.dumps([call["cmd"] for call in hermes_calls])
        all_argv_blob = json.dumps([call["cmd"] for call in fake_contract.calls])
        stage_env_calls = [call for call in fake_contract.calls if call["env"] and "HERMES_MISSION_STAGE" in call["env"]]
        env_blob = json.dumps([call["env"] for call in stage_env_calls], sort_keys=True)
        stdin_values = [call["stdin_data"] or "" for call in hermes_calls]
        check("prompt_three_hermes_calls", len(hermes_calls) == 3)
        check("prompt_absent_from_argv", sensitive_marker not in argv_blob and "HERMES_NATIVE_CANARY_OK" not in argv_blob)
        check("prompt_absent_from_env", sensitive_marker not in env_blob and "HERMES_NATIVE_CANARY_OK" not in env_blob)
        check("prompt_delivered_via_stdin", sum(sensitive_marker in value for value in stdin_values) == 3)
        check("acceptance_one_bash_call", len(acceptance_calls) == 1)
        check("acceptance_full_run_argv_exact", acceptance_calls and acceptance_calls[0]["cmd"] == ["/usr/bin/bash", "-e", "-u", "-o", "pipefail", "-s"])
        check("acceptance_full_run_stdin_exact", acceptance_calls and acceptance_calls[0]["stdin_data"] == acceptance_contract_body)
        check("acceptance_marker_absent_from_all_argv", sensitive_acceptance_marker not in all_argv_blob)
        check("acceptance_marker_absent_from_env", sensitive_acceptance_marker not in env_blob)
        check("query_file_argv_contract", all("--query-file" in call["cmd"] and "-" in call["cmd"] and "-q" not in call["cmd"] for call in hermes_calls))
        stage_profiles = {
            (
                (call["env"] or {}).get("HERMES_MISSION_STAGE"),
                (call["env"] or {}).get("HERMES_MISSION_PROFILE"),
                (call["env"] or {}).get("HERMES_MISSION_GOAL_ID"),
                (call["env"] or {}).get("HERMES_MISSION_RUN_ID"),
            )
            for call in stage_env_calls
        }
        check("correlation_env_stage_profile", stage_profiles == {
            ("plan", "reviewer", "contract-goal", "contract-goal"),
            ("code", "coder", "contract-goal", "contract-goal"),
            ("acceptance", "controller", "contract-goal", "contract-goal"),
            ("review", "reviewer", "contract-goal", "contract-goal"),
        })
        contract_events = (native_root / "runs" / "contract-goal" / "events.jsonl").read_text(encoding="utf-8")
        contract_result_path = native_root / "runs" / "contract-goal" / "result.json"
        contract_result_text = contract_result_path.read_text(encoding="utf-8") if contract_result_path.exists() else ""
        check("prompt_absent_from_events_results", sensitive_marker not in contract_events and sensitive_marker not in contract_result_text)
        check("acceptance_marker_absent_from_events_results", sensitive_acceptance_marker not in contract_events and sensitive_acceptance_marker not in contract_result_text)

        # ---- Test 20: Acceptance body preserves CRLF bytes and no file-final newline ----
        print("\n  --- Test 20: Acceptance body byte preservation ---")
        crlf_goal = (
            "---\r\n"
            "title: CRLF Goal\r\n"
            f"repo/workdir: {worktree_dir}\r\n"
            "dependencies:\r\n"
            "---\r\n"
            "\r\n"
            "CRLF goal.\r\n"
            "\r\n"
            "## Allowed files\r\n"
            "\r\n"
            "- `test.txt`\r\n"
            "\r\n"
            "## Acceptance\r\n"
            "\r\n"
            "```bash\r\n"
            "printf 'a\\r\\n'\r\n"
            "exit 0\r\n"
            "```"
        )
        parsed_crlf = parse_goal_markdown(crlf_goal)
        expected_crlf_body = "printf 'a\\r\\n'\r\nexit 0\r\n"
        check("acceptance_crlf_preserved", parsed_crlf["acceptance_body"] == expected_crlf_body)
        check(
            "acceptance_crlf_hash",
            hashlib.sha256(parsed_crlf["acceptance_body"].encode("utf-8")).hexdigest()
            == hashlib.sha256(expected_crlf_body.encode("utf-8")).hexdigest(),
        )

        # ---- Test 21: Oversized contracts fail parsing instead of truncating ----
        print("\n  --- Test 21: Oversized contract rejection ---")
        oversized_acceptance = "printf x\n" + ("#" * MAX_COMPLETE_PROMPT_BYTES)
        try:
            parse_goal_markdown(_make_test_goal(str(worktree_dir), title="Huge Acceptance", acceptance=oversized_acceptance))
            huge_acceptance_rejected = False
        except ValueError:
            huge_acceptance_rejected = True
        check("oversized_acceptance_rejected", huge_acceptance_rejected)
        huge_contract = _make_test_goal(str(worktree_dir), title="Huge Contract").replace(
            "Huge Contract for canary validation.",
            "R" * MAX_COMPLETE_PROMPT_BYTES,
        )
        try:
            parse_goal_markdown(huge_contract)
            huge_contract_rejected = False
        except ValueError:
            huge_contract_rejected = True
        check("oversized_contract_rejected", huge_contract_rejected)

        # ---- Test 22: Invalid UTF-8 ready goal quarantine ----
        print("\n  --- Test 22: Invalid UTF-8 quarantine ---")
        invalid_path = native_root / "goals" / "ready" / "invalid-utf8.md"
        invalid_path.write_bytes(b"---\ntitle: bad\nrepo/workdir: \xff\n")
        invalid_claim, _ = claim_ready_goal(native_root)
        check("invalid_utf8_not_claimed", invalid_claim is None)
        check("invalid_utf8_left_ready", not invalid_path.exists())
        check("invalid_utf8_moved_failed", (native_root / "goals" / "failed" / "invalid-utf8.md").exists())
        invalid_events = (native_root / "runs" / "invalid-utf8" / "events.jsonl").read_text()
        invalid_result = (native_root / "runs" / "invalid-utf8" / "result.json").read_text()
        check("invalid_utf8_no_decode_text", "codec" not in invalid_events and "0xff" not in invalid_events and "codec" not in invalid_result and "0xff" not in invalid_result)
        check("invalid_utf8_result_written", '"success": false' in invalid_result)

        # ---- Test 23: Terminal state transitions ready→running→done/failed ----
        print("\n  --- Test 23: Terminal state transitions ---")
        check("test1_ready_gone", not (native_root / "goals" / "ready" / "goal-success.md").exists())
        check("test1_done_exists", (native_root / "goals" / "done" / "goal-success.md").exists())
        check("test2_failed_exists", (native_root / "goals" / "failed" / "goal-empty-plan.md").exists())

        # ---- Test 24: proc stat parser with parens/spaces ----
        print("\n  --- Test 24: /proc stat parser ---")
        stat_with_parens = "88 (node (worker)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21"
        ppid_val, starttime_val = parse_proc_stat(stat_with_parens)
        check("parens_ppid", ppid_val == 1)
        check("parens_starttime", starttime_val == 19)

        stat_with_spaces = "99 (my long name) S 5 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 42 20 21"
        ppid_s, st_s = parse_proc_stat(stat_with_spaces)
        check("spaces_ppid", ppid_s == 5)
        check("spaces_starttime", st_s == 42)

        if old_allowed_roots is None:
            os.environ.pop("HERMES_NATIVE_ALLOWED_WORKTREE_ROOTS", None)
        else:
            os.environ["HERMES_NATIVE_ALLOWED_WORKTREE_ROOTS"] = old_allowed_roots

    # Summary
    failed = [r for r in results if not r[1]]
    total = len(results)
    passed = total - len(failed)
    print(f"\n[self-test] {passed}/{total} assertions passed")
    if failed:
        for name, _, detail in failed:
            print(f"  FAILED: {name}" + (f" — {detail}" if detail else ""))
        return False, f"{len(failed)} assertion(s) failed"
    return True, f"All {total} assertions passed"


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Hermes Native Goal Runtime")
    parser.add_argument("--self-test", action="store_true", help="Run synthetic self-test suite")
    parser.add_argument(
        "--native-root",
        type=str,
        default=str(DEFAULT_NATIVE_ROOT),
        help=f"Native runtime root (default: {DEFAULT_NATIVE_ROOT})",
    )

    args = parser.parse_args()

    if args.self_test:
        success, message = self_test()
        print(f"[self-test] Result: {'PASS' if success else 'FAIL'} - {message}")
        sys.exit(0 if success else 1)

    native_root = Path(args.native_root)
    ensure_dir_durable(native_root)
    subprocess_adapter = RealSubprocess()

    # Main loop — claim and execute one goal at a time
    while True:
        goal_id: str | None = None
        pid = os.getpid()
        start_ticks: int | None = None
        try:
            goal_path, goal_data = claim_ready_goal(native_root)
            if goal_path is None:
                time.sleep(1)
                continue

            assert goal_path is not None and goal_data is not None
            goal_id = goal_data["goal_id"]
            pid = int(goal_data.get("_controller_pid") or pid)
            claimed_start_ticks = goal_data.get("_controller_start_ticks")
            start_ticks = claimed_start_ticks if isinstance(claimed_start_ticks, int) and claimed_start_ticks > 0 else None

            success, stages = run_goal(goal_path, goal_data, native_root, subprocess_adapter)
            finalize_result(native_root, goal_id, success, stages, pid, start_ticks)

        except Exception as exc:
            if goal_id and not isinstance(exc, TerminalMoveError):
                events_path = native_root / "runs" / goal_id / "events.jsonl"
                try:
                    log_event(events_path, "runner.failed", "Unhandled runner exception", {"exception_type": type(exc).__name__})
                    finalize_result(
                        native_root,
                        goal_id,
                        False,
                        {"runner_exception": {"type": type(exc).__name__}},
                        pid,
                        start_ticks,
                    )
                except Exception as finalize_exc:
                    log_controller_warning(
                        native_root,
                        "Failed to finalize goal after runner exception",
                        {"goal_id": goal_id, "exception_type": type(finalize_exc).__name__},
                    )
            else:
                log_controller_warning(native_root, "Runner exception before goal claim", {"exception_type": type(exc).__name__})
            time.sleep(1)


if __name__ == "__main__":
    main()
