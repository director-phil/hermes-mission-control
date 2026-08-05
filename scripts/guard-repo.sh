#!/usr/bin/env bash
set -euo pipefail

expected_root="/home/phillip_downs/Documents/GitHub/hermes-mission-control"
forbidden_root="/home/phillip_downs/Documents/GitHub/reliable-tradies-ops"
expected_remote="https://github.com/director-phil/hermes-mission-control.git"

# Get the resolved absolute path of PWD
actual_path="$(cd "$PWD" && pwd)"

# Check if in forbidden path first (fails closed)
case "$actual_path" in
  "$forbidden_root"|"${forbidden_root}"/*)
    echo "blocked: forbidden repo path"
    echo "forbidden: $forbidden_root"
    exit 1
    ;;
esac

# Get git worktree root and common dir
git_worktree_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"

# Validate we're in a hermes-mission-control repo (canonical or linked worktree)
if [[ -z "$git_worktree_root" ]] || [[ -z "$git_common_dir" ]]; then
  echo "blocked: wrong repo"
  echo "not a git repository"
  exit 1
fi

# For canonical checkout: root must match expected_root and common dir must be .git inside it
if [[ "$actual_path" == "$expected_root" ]]; then
  # Canonical checkout: .git directory must exist at $expected_root/.git
  if [[ ! -d "$expected_root/.git" ]]; then
    echo "blocked: wrong repo"
    echo "canonical repo missing .git directory"
    exit 1
  fi
  # Common dir for canonical should be the .git dir itself (or inside it)
  if [[ "$git_common_dir" != "$expected_root/.git" ]] && [[ ! "$git_common_dir" == "${expected_root}/.git/"* ]]; then
    echo "blocked: wrong repo"
    echo "canonical repo common dir mismatch"
    echo "expected: $expected_root/.git"
    echo "actual: $git_common_dir"
    exit 1
  fi
else
  # For worktrees: resolved path must be inside expected_root's .git/commondir structure
  # and origin must match exactly
  if [[ "$git_common_dir" != "$expected_root/.git" ]] && [[ ! "$git_common_dir" == "${expected_root}/.git/"* ]]; then
    echo "blocked: wrong repo"
    echo "worktree common dir does not point to canonical hermes-mission-control .git"
    echo "expected common dir under: $expected_root/.git"
    echo "actual common dir: $git_common_dir"
    exit 1
  fi
fi

# Verify remote (same check for canonical and worktrees)
remote="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$remote" ]]; then
  echo "blocked: wrong repo"
  echo "missing origin remote"
  exit 1
fi
if [[ "$remote" != "$expected_remote" ]]; then
  echo "blocked: wrong remote"
  echo "expected: $expected_remote"
  echo "actual: $remote"
  exit 1
fi

echo "mission-control repo guard passed"
