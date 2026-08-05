#!/usr/bin/env bash
set -euo pipefail

# Install hermes-native-goal-runner systemd user service.
# Does NOT stop/disable old execution services.
# Does NOT automatically start the new runner before canary acceptance.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_SRC="$REPO_DIR/systemd/hermes-native-goal-runner.service"
RUNNER_SCRIPT="$REPO_DIR/scripts/hermes_native_goal_runner.py"
SERVICE_DEST="$HOME/.config/systemd/user/hermes-native-goal-runner.service"
SERVICE_NAME="hermes-native-goal-runner.service"
V2_SOURCE_PARENT="$HOME/.hermes/mission-control-source"
V2_CANONICAL_REPO="$V2_SOURCE_PARENT/rt-ops-v2"
V2_PRIMARY_WIP_CHECKOUT="$HOME/Documents/GitHub/reliable-tradies-ops-v2"
V2_CANONICAL_ARG="--canonical-repo %h/.hermes/mission-control-source/rt-ops-v2"
V2_ORIGIN_ARG="--expected-origin https://github.com/director-phil/rt-ops-v2.git"
V2_EXPECTED_ORIGIN="https://github.com/director-phil/rt-ops-v2.git"
SERVICE_EXEC_START="ExecStart=/usr/bin/python3 %h/Documents/GitHub/hermes-mission-control/scripts/hermes_native_goal_runner.py $V2_CANONICAL_ARG $V2_ORIGIN_ARG"
SERVICE_PATH_ENV="Environment=PATH=/usr/bin:/bin:/usr/local/bin"
CONTROLLER_GIT_DIR="$HOME/.hermes/mission-control/runtime/controller-git"
CONTROLLER_GIT_GLOBAL_CONFIG="$CONTROLLER_GIT_DIR/empty-global-config"
CONTROLLER_GIT_SYSTEM_CONFIG="$CONTROLLER_GIT_DIR/empty-system-config"
CONTROLLER_GIT_EMPTY_HOOKS="$CONTROLLER_GIT_DIR/empty-hooks"
CONTROL_PLANE_ALLOWED_REMOTE_FETCH="+refs/heads/*:refs/remotes/origin/*"
TRUSTED_CHILD_PATH="/usr/bin:/bin:/usr/local/bin"
TRUSTED_GIT_BIN=""
TRUSTED_GH_BIN=""

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

path_mode() {
  stat -c "%a" "$1"
}

path_uid() {
  stat -c "%u" "$1"
}

runner_trust_preflight() {
  local name="$1"
  local output
  if ! output="$(/usr/bin/python3 "$RUNNER_SCRIPT" --trust-preflight "$name" 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  local resolved="${output##* -> }"
  if [[ "$resolved" != /* ]]; then
    printf 'Trusted %s preflight did not return an absolute path: %s\n' "$name" "$output" >&2
    return 1
  fi
  printf '%s\n' "$resolved"
}

resolve_trusted_git() {
  if [[ -n "$TRUSTED_GIT_BIN" ]]; then
    printf '%s\n' "$TRUSTED_GIT_BIN"
    return
  fi
  TRUSTED_GIT_BIN="$(runner_trust_preflight git)" || fail "Trusted git executable trust preflight failed"
  printf '%s\n' "$TRUSTED_GIT_BIN"
}

resolve_trusted_gh_optional() {
  if [[ -n "$TRUSTED_GH_BIN" ]]; then
    printf '%s\n' "$TRUSTED_GH_BIN"
    return
  fi
  if TRUSTED_GH_BIN="$(runner_trust_preflight gh)"; then
    printf '%s\n' "$TRUSTED_GH_BIN"
    return
  fi
  return 1
}

preflight_hermes_trust() {
  local output
  if ! output="$(/usr/bin/python3 "$RUNNER_SCRIPT" --trust-preflight hermes 2>&1)"; then
    fail "Hermes executable trust preflight failed: $output"
  fi
}

preflight_vercel_trust() {
  local output
  if ! output="$(/usr/bin/python3 "$RUNNER_SCRIPT" --trust-preflight vercel 2>&1)"; then
    fail "Vercel executable trust preflight failed: $output"
  fi
}

validate_private_dir() {
  local path="$1"
  [[ ! -L "$path" ]] || fail "Controller private path is a symlink: $path"
  [[ -d "$path" ]] || fail "Controller private path is not a directory: $path"
  [[ "$(path_uid "$path")" == "$(id -u)" ]] || fail "Controller private path owner mismatch: $path"
  [[ "$(path_mode "$path")" == "700" ]] || fail "Controller private path mode must be 0700: $path"
}

ensure_private_dir() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    validate_private_dir "$path"
  else
    mkdir -m 700 "$path"
    validate_private_dir "$path"
  fi
}

ensure_controller_private_chain() {
  ensure_private_dir "$HOME/.hermes"
  ensure_private_dir "$HOME/.hermes/mission-control"
  ensure_private_dir "$HOME/.hermes/mission-control/runtime"
  ensure_private_dir "$CONTROLLER_GIT_DIR"
}

ensure_empty_regular_file() {
  local path="$1"
  local mode="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ ! -L "$path" ]] || fail "Controller Git config is a symlink: $path"
    [[ -f "$path" ]] || fail "Controller Git config is not a regular file: $path"
    [[ "$(path_uid "$path")" == "$(id -u)" ]] || fail "Controller Git config owner mismatch: $path"
    [[ ! -s "$path" ]] || fail "Controller Git config must be empty: $path"
    [[ "$(path_mode "$path")" == "$mode" ]] || fail "Controller Git config mode must be 0$mode: $path"
  else
    local old_umask
    old_umask="$(umask)"
    umask 077
    : >"$path"
    chmod "$mode" "$path"
    umask "$old_umask"
  fi
  [[ ! -L "$path" && -f "$path" && ! -s "$path" ]] || fail "Controller Git config invalid: $path"
}

ensure_empty_hooks_dir() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ ! -L "$path" ]] || fail "Controller Git hooks path is a symlink: $path"
    [[ -d "$path" ]] || fail "Controller Git hooks path is not a directory: $path"
    [[ "$(path_uid "$path")" == "$(id -u)" ]] || fail "Controller Git hooks path owner mismatch: $path"
    [[ "$(path_mode "$path")" == "500" ]] || fail "Controller Git hooks path mode must be 0500: $path"
    [[ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "Controller Git hooks path must be empty: $path"
  else
    mkdir -m 500 "$path"
  fi
}

ensure_controller_git_paths() {
  ensure_controller_private_chain
  ensure_empty_regular_file "$CONTROLLER_GIT_GLOBAL_CONFIG" "400"
  ensure_empty_regular_file "$CONTROLLER_GIT_SYSTEM_CONFIG" "444"
  ensure_empty_hooks_dir "$CONTROLLER_GIT_EMPTY_HOOKS"
}

git_env_args() {
  printf '%s\0' \
    "HOME=$HOME" \
    "USER=${USER:-}" \
    "LOGNAME=${LOGNAME:-}" \
    "PATH=$TRUSTED_CHILD_PATH" \
    "LANG=${LANG:-C}" \
    "CI=true" \
    "HERMES_LANGFUSE_CAPTURE_CONTENT=false" \
    "HERMES_LANGFUSE_CAPTURE_TOOL_IO=false" \
    "GIT_CONFIG_NOSYSTEM=1" \
    "GIT_CONFIG_GLOBAL=$CONTROLLER_GIT_GLOBAL_CONFIG" \
    "GIT_CONFIG_SYSTEM=$CONTROLLER_GIT_SYSTEM_CONFIG" \
    "GIT_OPTIONAL_LOCKS=${1:-0}" \
    "GIT_TERMINAL_PROMPT=0" \
    "GIT_ASKPASS=/bin/false" \
    "SSH_ASKPASS=/bin/false" \
    "GCM_INTERACTIVE=never"
  if [[ -n "${LC_ALL:-}" ]]; then
    printf '%s\0' "LC_ALL=$LC_ALL"
  fi
}

git_safe_config_args() {
  local gh_bin=""
  printf '%s\0' \
    "-c" "core.hooksPath=$CONTROLLER_GIT_EMPTY_HOOKS" \
    "-c" "core.askPass=" \
    "-c" "core.sshCommand=" \
    "-c" "credential.helper=" \
    "-c" "protocol.file.allow=never"
  if gh_bin="$(resolve_trusted_gh_optional)" && run_with_controller_env "$gh_bin" auth status -h github.com >/dev/null 2>&1; then
    printf '%s\0' "-c" "credential.https://github.com.helper=!$gh_bin auth git-credential"
  fi
}

run_with_controller_env() {
  local -a env_args=()
  while IFS= read -r -d '' item; do
    env_args+=("$item")
  done < <(git_env_args 0)
  env -i "${env_args[@]}" "$@"
}

run_git() {
  local optional_locks="$1"
  shift
  ensure_controller_git_paths
  local git_bin
  git_bin="$(resolve_trusted_git)"
  local -a env_args=()
  local -a config_args=()
  while IFS= read -r -d '' item; do
    env_args+=("$item")
  done < <(git_env_args "$optional_locks")
  while IFS= read -r -d '' item; do
    config_args+=("$item")
  done < <(git_safe_config_args)
  env -i "${env_args[@]}" "$git_bin" "${config_args[@]}" "$@"
}

git_read() {
  run_git 0 "$@"
}

git_mutate() {
  run_git 0 "$@"
}

local_config_value() {
  local repo="$1"
  local key="$2"
  git_read -C "$repo" config --local --get "$key" 2>/dev/null || true
}

assert_config_key_absent() {
  local repo="$1"
  local key="$2"
  local value
  value="$(local_config_value "$repo" "$key")"
  [[ -z "$value" ]] || fail "V2 canonical mirror forbidden Git config present: $key"
}

validate_git_control_plane() {
  local repo="$1"
  local origin
  local fetch_refspec
  local forbidden

  origin="$(git_read -C "$repo" remote get-url origin 2>/dev/null)" || fail "V2 canonical mirror origin is unreadable"
  [[ "$origin" == "$V2_EXPECTED_ORIGIN" ]] || fail "V2 canonical mirror origin mismatch: $origin"

  fetch_refspec="$(local_config_value "$repo" "remote.origin.fetch")"
  [[ "$fetch_refspec" == "$CONTROL_PLANE_ALLOWED_REMOTE_FETCH" ]] || fail "V2 canonical mirror origin fetch refspec mismatch"

  forbidden="$(git_read -C "$repo" config --local --name-only --get-regexp '^(alias|credential|include|includeIf|protocol|safe|ssh|url|http|https)\.' 2>/dev/null || true)"
  [[ -z "$forbidden" ]] || fail "V2 canonical mirror forbidden Git config present"

  for key in \
    core.askpass \
    core.hookspath \
    core.sshcommand \
    remote.origin.proxy \
    remote.origin.pushurl \
    remote.origin.receivepack \
    remote.origin.uploadpack
  do
    assert_config_key_absent "$repo" "$key"
  done
}

validate_clean_mirror() {
  local phase="$1"
  local top_level
  local physical_repo
  local status

  [[ -L "$V2_SOURCE_PARENT" ]] && fail "V2 source parent is a symlink: $V2_SOURCE_PARENT"
  [[ -L "$V2_CANONICAL_REPO" ]] && fail "V2 canonical mirror is a symlink: $V2_CANONICAL_REPO"
  [[ -d "$V2_CANONICAL_REPO" ]] || fail "V2 canonical mirror is missing during $phase"
  [[ -d "$V2_CANONICAL_REPO/.git" ]] || fail "V2 canonical mirror must be a standalone Git repo with a .git directory"

  top_level="$(git_read -C "$V2_CANONICAL_REPO" rev-parse --show-toplevel 2>/dev/null)" || fail "V2 canonical mirror is not a Git repo"
  physical_repo="$(cd "$V2_CANONICAL_REPO" && pwd -P)"
  [[ "$top_level" == "$physical_repo" ]] || fail "V2 canonical mirror top-level mismatch"

  validate_git_control_plane "$V2_CANONICAL_REPO"

  status="$(git_read -C "$V2_CANONICAL_REPO" status --porcelain=v1 2>/dev/null)" || fail "V2 canonical mirror status is unreadable"
  [[ -z "$status" ]] || fail "V2 canonical mirror is dirty; refusing to reset or clean work"
}

prepare_v2_canonical_mirror() {
  [[ "$V2_CANONICAL_REPO" == "$HOME/.hermes/mission-control-source/rt-ops-v2" ]] || fail "Unexpected V2 canonical mirror path"
  [[ "$V2_PRIMARY_WIP_CHECKOUT" == "$HOME/Documents/GitHub/reliable-tradies-ops-v2" ]] || fail "Unexpected primary WIP checkout path"
  ensure_controller_git_paths

  if [[ -e "$V2_SOURCE_PARENT" && ! -d "$V2_SOURCE_PARENT" ]]; then
    fail "V2 source parent exists but is not a directory: $V2_SOURCE_PARENT"
  fi
  [[ -L "$V2_SOURCE_PARENT" ]] && fail "V2 source parent is a symlink: $V2_SOURCE_PARENT"
  if [[ -e "$V2_SOURCE_PARENT" || -L "$V2_SOURCE_PARENT" ]]; then
    validate_private_dir "$V2_SOURCE_PARENT"
  else
    mkdir -m 700 "$V2_SOURCE_PARENT"
  fi

  if [[ -e "$V2_CANONICAL_REPO" ]]; then
    validate_clean_mirror "pre-refresh"
  else
    git_mutate clone "$V2_EXPECTED_ORIGIN" "$V2_CANONICAL_REPO"
    validate_clean_mirror "post-clone"
  fi

  git_mutate -C "$V2_CANONICAL_REPO" fetch origin main
  validate_git_control_plane "$V2_CANONICAL_REPO"
  if ! git_read -C "$V2_CANONICAL_REPO" merge-base --is-ancestor HEAD origin/main; then
    fail "V2 canonical mirror has local commits not contained in origin/main; refusing to reset"
  fi
  git_mutate -C "$V2_CANONICAL_REPO" checkout -B main origin/main
  validate_git_control_plane "$V2_CANONICAL_REPO"
  git_mutate -C "$V2_CANONICAL_REPO" reset --hard origin/main
  validate_clean_mirror "post-refresh"
}

# Validate source exists
if [[ ! -f "$SERVICE_SRC" ]]; then
  fail "Service file not found at $SERVICE_SRC"
fi
[[ -f "$RUNNER_SCRIPT" ]] || fail "Runner script not found at $RUNNER_SCRIPT"

preflight_hermes_trust
preflight_vercel_trust

prepare_v2_canonical_mirror

# Create systemd user directory
mkdir -p "$HOME/.config/systemd/user"

# Copy the checked-in unit file (no duplicated heredoc)
cp "$SERVICE_SRC" "$SERVICE_DEST"

actual_exec_start="$(grep -F 'ExecStart=' "$SERVICE_DEST" || true)"
[[ "$actual_exec_start" == "$SERVICE_EXEC_START" ]] || fail "Installed service ExecStart drift"
actual_path_env="$(grep -F 'Environment=PATH=' "$SERVICE_DEST" || true)"
[[ "$actual_path_env" == "$SERVICE_PATH_ENV" ]] || fail "Installed service PATH drift"
cmp -s "$SERVICE_SRC" "$SERVICE_DEST" || fail "Installed service differs from checked-in reviewed unit"

# Create private runtime directories.
install -d -m 700 "$HOME/.hermes"
install -d -m 700 "$HOME/.hermes/mission-control"
install -d -m 700 "$HOME/.hermes/mission-control/runtime"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals/ready"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals/staged"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals/running"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals/done"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals/failed"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/goals/changed_pending_surface_verification"
install -d -m 700 "$HOME/.hermes/mission-control/runtime/runs"
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
