#!/usr/bin/env bash
set -euo pipefail

expected_root="/home/phillip_downs/Documents/GitHub/hermes-mission-control"
forbidden_root="/home/phillip_downs/Documents/GitHub/reliable-tradies-ops"
expected_remote="https://github.com/director-phil/hermes-mission-control.git"

actual_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ "$actual_root" != "$expected_root" ]]; then
  echo "blocked: wrong repo"
  echo "expected: $expected_root"
  echo "actual: ${actual_root:-not a git repo}"
  exit 1
fi

case "$PWD" in
  "$forbidden_root"|"$forbidden_root"/*)
    echo "blocked: forbidden repo path"
    echo "forbidden: $forbidden_root"
    exit 1
    ;;
esac

remote="$(git remote get-url origin 2>/dev/null || true)"
if [[ "$remote" != "$expected_remote" ]]; then
  echo "blocked: wrong remote"
  echo "expected: $expected_remote"
  echo "actual: ${remote:-missing}"
  exit 1
fi

echo "mission-control repo guard passed"
