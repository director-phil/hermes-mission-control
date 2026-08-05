#!/usr/bin/env bash
set -euo pipefail

# Install hermes-native-goal-runner systemd user service.
# Does NOT stop/disable ChatDev services.
# Does NOT automatically start the new runner before canary acceptance.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_SRC="$REPO_DIR/systemd/hermes-native-goal-runner.service"
SERVICE_DEST="$HOME/.config/systemd/user/hermes-native-goal-runner.service"
SERVICE_NAME="hermes-native-goal-runner.service"

# Validate source exists
if [[ ! -f "$SERVICE_SRC" ]]; then
  echo "ERROR: Service file not found at $SERVICE_SRC" >&2
  exit 1
fi

# Create systemd user directory
mkdir -p "$HOME/.config/systemd/user"

# Copy the checked-in unit file (no duplicated heredoc)
cp "$SERVICE_SRC" "$SERVICE_DEST"

# Create runtime directories
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/ready"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/running"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/done"
mkdir -p "$HOME/.hermes/mission-control/runtime/goals/failed"
mkdir -p "$HOME/.hermes/mission-control/runtime/runs"
mkdir -p "$HOME/.hermes/mission-control-worktrees"

# Reload systemd but do NOT start the service
systemctl --user daemon-reload 2>/dev/null || true

echo "Service installed at $SERVICE_DEST"
echo "Enable with: systemctl --user enable $SERVICE_NAME"
echo "Start with: systemctl --user start $SERVICE_NAME"
echo ""
echo "NOTE: Do not start before canary acceptance passes."
