#!/usr/bin/env python3
"""
conveyor-goal-mirror.py — read-only mirror of ChatDev goal lifecycle into the
Mission Control native goal runtime.

Reconstructed 2026-11-02 from the vault's documented contract after the
2026-10-30 coder reflash wiped the original (which was machine-local, never
committed):

  - 2026-08-06 "Mission Control Visibility" — state mapping contract:
      active + live-proc -> running
      active / staged     -> ready
      done                -> done
      failed              -> failed
  - 2026-10-06 a584381 "distinguish stalled" — active goal whose controller
      process is gone (live-but-inactive) -> stalled, not running.
  - 2026-09-23 "Native Goal Conveyor" race fix — the mirror must not delete a
      goal the native runner owns (ready/running/done/failed) and must not
      re-stage a goal already in a higher state.
  - 573760e — mtime is preserved via shutil.copy2 so the native reader can
      resolve updatedAt from file mtime when frontmatter carries no date.

Read-only on ChatDev. Never mutates ~/ChatDev/goals. Writes only under
~/.hermes/mission-control/runtime/goals/<state>/.
"""

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

CHATDEV_GOALS = Path.home() / "ChatDev" / "goals"
NATIVE_ROOT = Path.home() / ".hermes" / "mission-control" / "runtime" / "goals"

# Native state dirs the dashboard reads (order is terminal-first so a goal
# found in a higher-precedence dir wins over a lower one).
STATE_DIRS = [
    "done",
    "failed",
    "shipping",
    "running",
    "stalled",
    "ready",
    "staged",
]

LOOP_SECONDS = 10


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def live_controller_gids() -> set[str]:
    """Return goal ids with a live `escalate.py run g_...` process (via /proc)."""
    found: set[str] = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            parts = [
                p.decode(errors="replace")
                for p in (proc / "cmdline").read_bytes().split(b"\0")
                if p
            ]
        except OSError:
            continue
        if not parts:
            continue
        executable = Path(parts[0]).name
        if (
            executable.startswith("python")
            and len(parts) >= 4
            and parts[1].endswith("bridge/escalate.py")
            and parts[2] == "run"
            and parts[3].startswith("g_")
        ):
            found.add(parts[3])
    return found


def read_state_status(gid: str) -> str | None:
    """Read the authoritative lifecycle status from goals/state/<gid>.json."""
    p = CHATDEV_GOALS / "state" / f"{gid}.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(errors="replace"))
        status = data.get("status")
        return status if isinstance(status, str) else None
    except (OSError, json.JSONDecodeError):
        return None


def chatdev_goal_files() -> dict[str, Path]:
    """Map gid -> source goal markdown file across active/staged/done/failed/paused.

    A goal id is derived from the file stem (strip any `.md`), matching the
    conveyor's `g_...` naming. Terminal dirs (done/failed) take precedence over
    active/staged, so a stale copy in staged never demotes a done goal.
    """
    result: dict[str, Path] = {}
    # Terminal first: done > failed > active > staged > paused
    for state in ("done", "failed", "active", "staged", "paused"):
        d = CHATDEV_GOALS / state
        if not d.is_dir():
            continue
        # Flat layout: goals/<state>/<gid>.md
        for f in d.glob("*.md"):
            if f.stem.startswith("g_"):
                result.setdefault(f.stem, f)
        # Nested layout: goals/<state>/<gid>/<gid>.md
        for f in d.glob("*/*.md"):
            if f.stem.startswith("g_") and f.stem == f.parent.name:
                result.setdefault(f.stem, f)
    return result


def classify(gid: str, source_file: Path, live: set[str]) -> str:
    """Map a ChatDev goal to its native state (per the documented contract)."""
    status = read_state_status(gid)
    if status == "done":
        return "done"
    if status == "failed":
        return "failed"
    if status == "shipping":
        return "shipping"
    # Physical location is authoritative when state json is absent/stale.
    # Nested layout is <state>/<gid>/<gid>.md, so the state dir is the
    # grandparent of the file; flat layout is <state>/<gid>.md (parent).
    parent = source_file.parent
    location = parent.name if parent.name != source_file.stem else parent.parent.name
    if location == "done":
        return "done"
    if location == "failed":
        return "failed"
    if location == "active":
        return "running" if gid in live else "stalled"
    if location == "staged":
        return "ready"
    # paused and anything else: not surfaced (native store has no paused lane).
    return ""


def reconcile(desired: dict[str, tuple[str, Path]]) -> tuple[int, int]:
    """Bring the native store in line with `desired` (gid -> (state, source)).

    Returns (moved, removed). Read-only on ChatDev: only writes under NATIVE_ROOT.
    """
    desired_states: dict[str, set[str]] = {s: set() for s in STATE_DIRS}
    for gid, (state, _src) in desired.items():
        if state:
            desired_states[state].add(gid)

    moved = 0
    removed = 0

    # Remove native files whose gid is no longer desired in that state.
    MIRROR_MUTABLE = {"ready", "staged", "running", "stalled"}
    for state in MIRROR_MUTABLE:
        d = NATIVE_ROOT / state
        if not d.is_dir():
            continue
        for f in d.glob("*.md"):
            gid = f.stem
            if gid not in desired_states[state]:
                try:
                    f.unlink()
                    removed += 1
                except OSError:
                    pass

    # Terminal dirs (done/failed/shipping): a goal may live in exactly ONE
    # terminal state. When it moves (failed -> shipping -> done on recovery),
    # the stale copy in the old dir must be removed or the dashboard sees the
    # same gid in two states and raises "Duplicate native goal ID". We remove a
    # terminal copy ONLY when that gid is still classified into a DIFFERENT
    # state; a goal the mirror no longer sees at all is left untouched (the
    # native-runner-owned record survives).
    TERMINAL = {"done", "failed", "shipping"}
    for state in TERMINAL:
        d = NATIVE_ROOT / state
        if not d.is_dir():
            continue
        for f in d.glob("*.md"):
            gid = f.stem
            if gid in desired_states[state]:
                continue  # still belongs in this exact state
            if any(gid in desired_states[s] for s in STATE_DIRS if s != state):
                try:
                    f.unlink()
                    removed += 1
                except OSError:
                    pass

    # Write/copy each goal into its native state dir (copy2 preserves mtime).
    # Skip when the destination is already current (same mtime + size) so the
    # 10s loop does not churn mtimes and re-order the reader's newest-first view.
    for gid, (state, source) in desired.items():
        if not state:
            continue
        dst = NATIVE_ROOT / state / source.name
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.is_file():
                ss = source.stat()
                ds = dst.stat()
                if ss.st_mtime_ns == ds.st_mtime_ns and ss.st_size == ds.st_size:
                    continue
            shutil.copy2(source, dst)
            moved += 1
        except OSError as e:
            log(f"copy2 failed for {gid}: {e}")

    return moved, removed


def run_once() -> None:
    live = live_controller_gids()
    sources = chatdev_goal_files()
    desired: dict[str, tuple[str, Path]] = {}
    for gid, source in sources.items():
        state = classify(gid, source, live)
        desired[gid] = (state, source)

    moved, removed = reconcile(desired)
    counts = {}
    for state in STATE_DIRS:
        d = NATIVE_ROOT / state
        counts[state] = len(list(d.glob("*.md"))) if d.is_dir() else 0
    log(
        f"mirror: {len(desired)} goals, {moved} copied, {removed} pruned | "
        + " ".join(f"{s}={counts[s]}" for s in ("ready", "running", "stalled", "done", "failed"))
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Mirror ChatDev goals into the MC native runtime")
    parser.add_argument("--loop", action="store_true", help="run forever on a fixed interval")
    args = parser.parse_args()

    if not CHATDEV_GOALS.is_dir():
        log(f"ChatDev goals root missing: {CHATDEV_GOALS}")
        return 1

    if args.loop:
        while True:
            run_once()
            time.sleep(LOOP_SECONDS)
    else:
        run_once()
    return 0


if __name__ == "__main__":
    sys.exit(main())
