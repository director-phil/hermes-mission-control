#!/usr/bin/env bash
set -euo pipefail

# Install hermes-native-goal-runner systemd user service.
# Does NOT stop/disable old execution services.
# Does NOT automatically start the new runner before canary acceptance.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_SRC="$REPO_DIR/systemd/hermes-native-goal-runner.service"
SERVICE_DEST="$HOME/.config/systemd/user/hermes-native-goal-runner.service"
SERVICE_NAME="hermes-native-goal-runner.service"
V2_SOURCE_PARENT="$HOME/.hermes/mission-control-source"
V2_CANONICAL_REPO="$V2_SOURCE_PARENT/rt-ops-v2"
V2_PRIMARY_WIP_CHECKOUT="$HOME/Documents/GitHub/reliable-tradies-ops-v2"
V2_CANONICAL_ARG="--canonical-repo %h/.hermes/mission-control-source/rt-ops-v2"
V2_ORIGIN_ARG="--expected-origin https://github.com/director-phil/rt-ops-v2.git"
V2_EXPECTED_ORIGIN="https://github.com/director-phil/rt-ops-v2.git"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

validate_clean_mirror() {
  local phase="$1"
  local top_level
  local physical_repo
  local origin
  local status

  [[ -L "$V2_SOURCE_PARENT" ]] && fail "V2 source parent is a symlink: $V2_SOURCE_PARENT"
  [[ -L "$V2_CANONICAL_REPO" ]] && fail "V2 canonical mirror is a symlink: $V2_CANONICAL_REPO"
  [[ -d "$V2_CANONICAL_REPO" ]] || fail "V2 canonical mirror is missing during $phase"
  [[ -d "$V2_CANONICAL_REPO/.git" ]] || fail "V2 canonical mirror must be a standalone Git repo with a .git directory"

  top_level="$(git -C "$V2_CANONICAL_REPO" rev-parse --show-toplevel 2>/dev/null)" || fail "V2 canonical mirror is not a Git repo"
  physical_repo="$(cd "$V2_CANONICAL_REPO" && pwd -P)"
  [[ "$top_level" == "$physical_repo" ]] || fail "V2 canonical mirror top-level mismatch"

  origin="$(git -C "$V2_CANONICAL_REPO" remote get-url origin 2>/dev/null)" || fail "V2 canonical mirror origin is unreadable"
  [[ "$origin" == "$V2_EXPECTED_ORIGIN" ]] || fail "V2 canonical mirror origin mismatch: $origin"

  status="$(git -C "$V2_CANONICAL_REPO" status --porcelain=v1 2>/dev/null)" || fail "V2 canonical mirror status is unreadable"
  [[ -z "$status" ]] || fail "V2 canonical mirror is dirty; refusing to reset or clean work"
}

prepare_v2_canonical_mirror() {
  [[ "$V2_CANONICAL_REPO" == "$HOME/.hermes/mission-control-source/rt-ops-v2" ]] || fail "Unexpected V2 canonical mirror path"
  [[ "$V2_PRIMARY_WIP_CHECKOUT" == "$HOME/Documents/GitHub/reliable-tradies-ops-v2" ]] || fail "Unexpected primary WIP checkout path"

  if [[ -e "$V2_SOURCE_PARENT" && ! -d "$V2_SOURCE_PARENT" ]]; then
    fail "V2 source parent exists but is not a directory: $V2_SOURCE_PARENT"
  fi
  [[ -L "$V2_SOURCE_PARENT" ]] && fail "V2 source parent is a symlink: $V2_SOURCE_PARENT"
  mkdir -p "$V2_SOURCE_PARENT"

  if [[ -e "$V2_CANONICAL_REPO" ]]; then
    validate_clean_mirror "pre-refresh"
  else
    git clone "$V2_EXPECTED_ORIGIN" "$V2_CANONICAL_REPO"
    validate_clean_mirror "post-clone"
  fi

  git -C "$V2_CANONICAL_REPO" fetch origin main
  if ! git -C "$V2_CANONICAL_REPO" merge-base --is-ancestor HEAD origin/main; then
    fail "V2 canonical mirror has local commits not contained in origin/main; refusing to reset"
  fi
  git -C "$V2_CANONICAL_REPO" checkout -B main origin/main
  git -C "$V2_CANONICAL_REPO" reset --hard origin/main
  validate_clean_mirror "post-refresh"
}

# Validate source exists
if [[ ! -f "$SERVICE_SRC" ]]; then
  fail "Service file not found at $SERVICE_SRC"
fi

prepare_v2_canonical_mirror

# Create systemd user directory
mkdir -p "$HOME/.config/systemd/user"

# Copy the checked-in unit file (no duplicated heredoc)
cp "$SERVICE_SRC" "$SERVICE_DEST"

if ! grep -F -- "$V2_CANONICAL_ARG" "$SERVICE_DEST" >/dev/null; then
  echo "ERROR: Installed service is missing explicit RT V2 canonical repo target" >&2
  exit 1
fi
if ! grep -F -- "$V2_ORIGIN_ARG" "$SERVICE_DEST" >/dev/null; then
  echo "ERROR: Installed service is missing explicit RT V2 origin target" >&2
  exit 1
fi

# Create runtime directories
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/ready"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/staged"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/running"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/done"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/failed"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/changed_pending_surface_verification"
mkdir -p "$HOME/.hermes/mission-control/runtime/runs"
mkdir -p "$HOME/.hermes/mission-control-worktrees"

# Reload systemd but do NOT start the service
systemctl --user daemon-reload 2>/dev/null || true

echo "Service installed at $SERVICE_DEST"
echo "Canonical mirror: $V2_CANONICAL_REPO"
echo "Primary WIP checkout left untouched: $V2_PRIMARY_WIP_CHECKOUT"
echo "Target origin: https://github.com/director-phil/rt-ops-v2.git"
echo "Enable with: systemctl --user enable $SERVICE_NAME"
echo "Start with: systemctl --user start $SERVICE_NAME"
echo ""
echo "NOTE: Do not start before canary acceptance passes."
