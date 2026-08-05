#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALLER="$REPO_DIR/scripts/install-hermes-native-goal-runner.sh"
RUNNER_SCRIPT="$REPO_DIR/scripts/hermes_native_goal_runner.py"
EXPECTED_ORIGIN="https://github.com/director-phil/rt-ops-v2.git"
EXPECTED_FETCH="+refs/heads/*:refs/remotes/origin/*"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_trusted_bin() {
  local fakebin="$1"
  local log="$2"
  mkdir -p "$fakebin"
  cat >"$fakebin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

expected_global="$HOME/.hermes/mission-control/runtime/controller-git/empty-global-config"
expected_system="$HOME/.hermes/mission-control/runtime/controller-git/empty-system-config"
expected_origin="https://github.com/director-phil/rt-ops-v2.git"
expected_fetch="+refs/heads/*:refs/remotes/origin/*"
log_path="__HERMES_FAKE_GIT_LOG__"

{
  printf 'CALL\n'
  printf 'ARGV=%s\n' "$*"
  printf 'ENV_HOME=%s\n' "${HOME-}"
  printf 'ENV_PATH=%s\n' "${PATH-}"
  printf 'ENV_GIT_CONFIG_NOSYSTEM=%s\n' "${GIT_CONFIG_NOSYSTEM-}"
  printf 'ENV_GIT_CONFIG_GLOBAL=%s\n' "${GIT_CONFIG_GLOBAL-}"
  printf 'ENV_GIT_CONFIG_SYSTEM=%s\n' "${GIT_CONFIG_SYSTEM-}"
  printf 'ENV_GIT_TERMINAL_PROMPT=%s\n' "${GIT_TERMINAL_PROMPT-}"
  printf 'ENV_GIT_ASKPASS=%s\n' "${GIT_ASKPASS-}"
  printf 'ENV_SSH_ASKPASS=%s\n' "${SSH_ASKPASS-}"
  printf 'ENV_GIT_SSH_COMMAND=%s\n' "${GIT_SSH_COMMAND-}"
  printf 'ENV_MALICIOUS=%s\n' "${MALICIOUS_AMBIENT-}"
} >>"$log_path"

[[ "${GIT_CONFIG_NOSYSTEM-}" == "1" ]] || exit 91
[[ "${GIT_CONFIG_GLOBAL-}" == "$expected_global" ]] || exit 92
[[ "${GIT_CONFIG_SYSTEM-}" == "$expected_system" ]] || exit 93
[[ "${PATH-}" == "/usr/bin:/bin:/usr/local/bin" ]] || exit 103
[[ "${GIT_TERMINAL_PROMPT-}" == "0" ]] || exit 94
[[ "${GIT_ASKPASS-}" == "/bin/false" ]] || exit 95
[[ "${SSH_ASKPASS-}" == "/bin/false" ]] || exit 96
[[ -z "${GIT_SSH_COMMAND-}" && -z "${MALICIOUS_AMBIENT-}" ]] || exit 97

cwd="$PWD"
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c)
      shift 2
      ;;
    -C)
      cwd="$2"
      shift 2
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

case "${args[0]-}" in
  clone)
    [[ "${args[1]-}" == "$expected_origin" ]] || exit 98
    mkdir -p "${args[2]}/.git"
    cat >"${args[2]}/.git/config" <<CONFIG
[core]
	repositoryformatversion = 0
[remote "origin"]
	url = $expected_origin
	fetch = $expected_fetch
CONFIG
    ;;
  rev-parse)
    if [[ "${args[1]-}" == "--show-toplevel" ]]; then
      (cd "$cwd" && pwd -P)
    fi
    ;;
  remote)
    [[ "${args[*]}" == "remote get-url origin" ]] || exit 99
    printf '%s\n' "$expected_origin"
    ;;
  status)
    ;;
  fetch)
    [[ "${args[*]}" == "fetch origin main" ]] || exit 100
    ;;
  merge-base)
    exit 0
    ;;
  checkout)
    [[ "${args[*]}" == "checkout -B main origin/main" ]] || exit 101
    ;;
  reset)
    [[ "${args[*]}" == "reset --hard origin/main" ]] || exit 102
    ;;
  config)
    if [[ "${args[1]-}" == "--local" && "${args[2]-}" == "--name-only" && "${args[3]-}" == "--get-regexp" ]]; then
      config_path="$cwd/.git/config"
      if [[ -f "$config_path" ]] && grep -Eq '^\[http "https://github\.com/"\]|^[[:space:]]*http\.https://github\.com\.proxy[[:space:]]*=' "$config_path"; then
        printf '%s\n' 'http.https://github.com.proxy'
        exit 0
      fi
      exit 1
    fi
    if [[ "${args[*]}" == "config --local --get remote.origin.fetch" ]]; then
      printf '%s\n' "$expected_fetch"
      exit 0
    fi
    if [[ "${args[1]-}" == "--local" && "${args[2]-}" == "--get" ]]; then
      exit 1
    fi
    ;;
esac
exit 0
EOF
  sed -i "s#__HERMES_FAKE_GIT_LOG__#$log#g" "$fakebin/git"
  chmod +x "$fakebin/git"

  cat >"$fakebin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log_path="__HERMES_FAKE_GIT_LOG__"
{
  printf 'GH_CALL\n'
  printf 'GH_ARGV=%s\n' "$*"
  printf 'GH_ENV_PATH=%s\n' "${PATH-}"
  printf 'GH_ENV_MALICIOUS=%s\n' "${MALICIOUS_AMBIENT-}"
} >>"$log_path"
[[ "${PATH-}" == "/usr/bin:/bin:/usr/local/bin" ]] || exit 81
[[ -z "${MALICIOUS_AMBIENT-}" ]] || exit 82
exit 0
EOF
  sed -i "s#__HERMES_FAKE_GIT_LOG__#$log#g" "$fakebin/gh"
  chmod +x "$fakebin/gh"

  cat >"$fakebin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$fakebin/systemctl"
}

make_hostile_bin() {
  local hostilebin="$1"
  local hostile_log="$2"
  mkdir -p "$hostilebin"
  for name in git gh; do
    cat >"$hostilebin/$name" <<EOF
#!/usr/bin/env bash
printf '%s\n' "HOSTILE $name \$*" >>"$hostile_log"
exit 77
EOF
    chmod +x "$hostilebin/$name"
  done
  cat >"$hostilebin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$hostilebin/systemctl"
}

assert_production_installer_has_no_test_seams() {
  ! grep -Eq 'HERMES_INSTALLER_TEST_|validate_test_executable_override|TEST_TRUSTED|TEST_SERVICE|TEST_MODE' "$INSTALLER" || fail "production installer still contains installer test controls"
  grep -F 'SERVICE_SRC="$REPO_DIR/systemd/hermes-native-goal-runner.service"' "$INSTALLER" >/dev/null || fail "production installer no longer uses checked-in service source"
  grep -F 'RUNNER_SCRIPT="$REPO_DIR/scripts/hermes_native_goal_runner.py"' "$INSTALLER" >/dev/null || fail "production installer no longer uses checked-in runner script"
  grep -F 'TRUSTED_GIT_BIN="$(runner_trust_preflight git)"' "$INSTALLER" >/dev/null || fail "production installer no longer resolves git through runner trust preflight"
  grep -F 'TRUSTED_GH_BIN="$(runner_trust_preflight gh)"' "$INSTALLER" >/dev/null || fail "production installer no longer resolves gh through runner trust preflight"
  ! grep -Eq 'command[[:space:]]+-v[[:space:]]+(git|gh)|SERVICE_SRC=.*\$\{[^}]+:-|RUNNER_SCRIPT=.*\$\{[^}]+:-|V2_CANONICAL_REPO=.*\$\{[^}]+:-|V2_EXPECTED_ORIGIN=.*\$\{[^}]+:-' "$INSTALLER" || fail "production installer still has ambient command/path override shapes"
}

make_installer_fixture() {
  local output_path="$1"
  local trusted_git="$2"
  local trusted_gh="$3"
  local service_src="${4:-}"
  /usr/bin/python3 - "$INSTALLER" "$output_path" "$RUNNER_SCRIPT" "$trusted_git" "$trusted_gh" "$service_src" <<'PY'
import shlex
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
runner_script = sys.argv[3]
trusted_git = sys.argv[4]
trusted_gh = sys.argv[5]
service_src = sys.argv[6]

text = source.read_text(encoding="utf-8")
text = text.replace(
    'RUNNER_SCRIPT="$REPO_DIR/scripts/hermes_native_goal_runner.py"',
    f"RUNNER_SCRIPT={shlex.quote(runner_script)}",
)
if service_src:
    text = text.replace(
        'SERVICE_SRC="$REPO_DIR/systemd/hermes-native-goal-runner.service"',
        f"SERVICE_SRC={shlex.quote(service_src)}",
    )

start = text.index("runner_trust_preflight() {")
end = text.index("\nresolve_trusted_git() {", start)
replacement = f'''runner_trust_preflight() {{
  local name="$1"
  local output
  case "$name" in
    git)
      if ! output="$(/usr/bin/python3 "$RUNNER_SCRIPT" --trust-executable {shlex.quote(trusted_git)} 2>&1)"; then
        printf '%s\\n' "$output" >&2
        return 1
      fi
      printf '%s\\n' {shlex.quote(trusted_git)}
      return
      ;;
    gh)
      if ! output="$(/usr/bin/python3 "$RUNNER_SCRIPT" --trust-executable {shlex.quote(trusted_gh)} 2>&1)"; then
        printf '%s\\n' "$output" >&2
        return 1
      fi
      printf '%s\\n' {shlex.quote(trusted_gh)}
      return
      ;;
    *)
      if ! output="$(/usr/bin/python3 "$RUNNER_SCRIPT" --trust-preflight "$name" 2>&1)"; then
        printf '%s\\n' "$output" >&2
        return 1
      fi
      local resolved="${{output##* -> }}"
      if [[ "$resolved" != /* ]]; then
        printf 'Trusted %s preflight did not return an absolute path: %s\\n' "$name" "$output" >&2
        return 1
      fi
      printf '%s\\n' "$resolved"
      ;;
  esac
}}
'''
text = text[:start] + replacement + text[end + 1:]
target.write_text(text, encoding="utf-8")
target.chmod(0o700)
PY
}

make_fake_hermes_install() {
  local home_dir="$1"
  local agent="$home_dir/.hermes/hermes-agent"
  local venv="$agent/venv"
  local site_packages="$venv/lib/python3.11/site-packages"
  local python_target="$home_dir/.local/share/uv/python/cpython-3.11.15-linux-aarch64-gnu/bin/python3.11"
  mkdir -p \
    "$home_dir/.local/bin" \
    "$venv/bin" \
    "$site_packages/hermes_agent-0.20.0.dist-info" \
    "$agent/hermes_cli" \
    "$(dirname "$python_target")"
  chmod 700 "$home_dir/.hermes"
  chmod 775 "$home_dir/.local"
  chmod 775 "$home_dir/.local/bin" "$agent" "$venv" "$venv/bin" "$site_packages" "$site_packages/hermes_agent-0.20.0.dist-info" "$agent/hermes_cli" "$(dirname "$python_target")"
  cat >"$home_dir/.local/bin/hermes" <<EOF
#!/usr/bin/env bash
unset PYTHONPATH
unset PYTHONHOME
exec "$venv/bin/hermes" "\$@"
EOF
  chmod 775 "$home_dir/.local/bin/hermes"
  cat >"$venv/bin/hermes" <<EOF
#!$venv/bin/python3
import sys
from hermes_cli.main import main
if __name__ == "__main__":
    sys.exit(main())
EOF
  chmod 775 "$venv/bin/hermes"
  cat >"$python_target" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod 775 "$python_target"
  ln -sf "$python_target" "$venv/bin/python3"
  cat >"$site_packages/__editable__.hermes_agent-0.20.0.pth" <<'EOF'
import __editable___hermes_agent_0_20_0_finder; __editable___hermes_agent_0_20_0_finder.install()
EOF
  chmod 664 "$site_packages/__editable__.hermes_agent-0.20.0.pth"
  cat >"$site_packages/__editable___hermes_agent_0_20_0_finder.py" <<EOF
MAPPING = {'hermes_cli': '$agent/hermes_cli'}
NAMESPACES = {}
def install():
    return None
EOF
  chmod 664 "$site_packages/__editable___hermes_agent_0_20_0_finder.py"
  cat >"$site_packages/hermes_agent-0.20.0.dist-info/direct_url.json" <<EOF
{"url":"file://$agent","dir_info":{"editable":true}}
EOF
  chmod 664 "$site_packages/hermes_agent-0.20.0.dist-info/direct_url.json"
  printf '[project]\nname = "hermes-agent"\n' >"$agent/pyproject.toml"
  printf 'def main():\n    return 0\n' >"$agent/hermes_cli/__init__.py"
  printf 'def main():\n    return 0\n' >"$agent/hermes_cli/main.py"
  chmod 664 "$agent/pyproject.toml" "$agent/hermes_cli/__init__.py" "$agent/hermes_cli/main.py"
}

make_fake_vercel_install() {
  local home_dir="$1"
  local node_root="$home_dir/.hermes/node"
  local local_bin="$home_dir/.local/bin"
  local node_bin="$node_root/bin"
  local package_root="$node_root/lib/node_modules/vercel"
  local dist="$package_root/dist"
  mkdir -p "$local_bin" "$node_bin" "$dist"
  chmod 775 "$home_dir/.local" "$local_bin" "$node_root" "$node_bin" "$node_root/lib" "$node_root/lib/node_modules" "$package_root" "$dist"
  cat >"$node_bin/node" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod 775 "$node_bin/node"
  cat >"$dist/vc.js" <<'EOF'
#!/usr/bin/env node
console.log('vercel fixture')
EOF
  chmod 775 "$dist/vc.js"
  cat >"$package_root/package.json" <<'EOF'
{"name":"vercel","version":"54.14.0","bin":{"vc":"./dist/vc.js","vercel":"./dist/vc.js"}}
EOF
  chmod 664 "$package_root/package.json"
  ln -sf ../lib/node_modules/vercel/dist/vc.js "$node_bin/vercel"
  ln -sf "$node_bin/vercel" "$local_bin/vercel"
}

run_installer_with_home() {
  local home_dir="$1"
  local hostilebin="$2"
  local log="$3"
  local trusted_git="$4"
  local trusted_gh="$5"
  local service_src="${6:-}"
  local hermes_fixture="${7:-trusted}"
  local vercel_fixture="${8:-trusted}"
  mkdir -p "$home_dir"
  if [[ "$hermes_fixture" == "trusted" ]]; then
    make_fake_hermes_install "$home_dir"
  fi
  if [[ "$vercel_fixture" == "trusted" ]]; then
    make_fake_vercel_install "$home_dir"
  elif [[ "$vercel_fixture" == "missing-node" ]]; then
    make_fake_vercel_install "$home_dir"
    rm -f "$home_dir/.hermes/node/bin/node"
  fi
  local installer_under_test="$tmp/installer-$(basename "$home_dir").sh"
  make_installer_fixture "$installer_under_test" "$trusted_git" "$trusted_gh" "$service_src"
  HOME="$home_dir" \
  USER="installer-test" \
  LOGNAME="installer-test" \
  PATH="$hostilebin:/usr/bin:/bin" \
  HERMES_INSTALLER_TEST_MODE="hostile-ignored" \
  HERMES_INSTALLER_TEST_TRUSTED_GIT="$hostilebin/git" \
  HERMES_INSTALLER_TEST_TRUSTED_GH="$hostilebin/gh" \
  HERMES_INSTALLER_TEST_SERVICE_SRC="$tmp/hostile.service" \
  HERMES_INSTALLER_TEST_CANONICAL_REPO="$tmp/hostile-canonical" \
  HERMES_INSTALLER_TEST_ORIGIN="https://github.com/evil/evil.git" \
  HERMES_FAKE_GIT_LOG="$log" \
  GIT_CONFIG_GLOBAL="MALICIOUS_AMBIENT_GLOBAL" \
  GIT_CONFIG_SYSTEM="MALICIOUS_AMBIENT_SYSTEM" \
  GIT_SSH_COMMAND="MALICIOUS_AMBIENT_SSH" \
  GIT_ASKPASS="MALICIOUS_AMBIENT_ASKPASS" \
  SSH_ASKPASS="MALICIOUS_AMBIENT_SSH_ASKPASS" \
  MALICIOUS_AMBIENT="MALICIOUS_AMBIENT_VALUE" \
  bash "$installer_under_test"
}

assert_production_installer_has_no_test_seams

tmp="$(mktemp -d "$REPO_DIR/.installer-test.XXXXXX")"
trap 'chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
trustedbin="$tmp/trustedbin"
hostilebin="$tmp/hostilebin"
log="$tmp/git.log"
hostile_log="$tmp/hostile.log"
make_trusted_bin "$trustedbin" "$log"
make_hostile_bin "$hostilebin" "$hostile_log"

success_home="$tmp/home-success"
run_installer_with_home "$success_home" "$hostilebin" "$log" "$trustedbin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-success.out 2>/tmp/hermes-installer-test-success.err

grep -q '^CALL$' "$log" || fail "fake git was not invoked"
grep -q '^GH_CALL$' "$log" || fail "trusted fake gh was not invoked"
[[ ! -s "$hostile_log" ]] || fail "hostile ambient git/gh was executed"
grep -q "ENV_PATH=/usr/bin:/bin:/usr/local/bin" "$log" || fail "git child PATH was not sanitized"
grep -q "GH_ENV_PATH=/usr/bin:/bin:/usr/local/bin" "$log" || fail "gh child PATH was not sanitized"
grep -q "ENV_GIT_CONFIG_GLOBAL=$success_home/.hermes/mission-control/runtime/controller-git/empty-global-config" "$log" || fail "git global config was not controller-private"
grep -q "ENV_GIT_CONFIG_SYSTEM=$success_home/.hermes/mission-control/runtime/controller-git/empty-system-config" "$log" || fail "git system config was not controller-private"
grep -q "ENV_GIT_TERMINAL_PROMPT=0" "$log" || fail "git terminal prompt was not disabled"
grep -q "ENV_GIT_ASKPASS=/bin/false" "$log" || fail "git askpass was not disabled"
grep -q "ENV_SSH_ASKPASS=/bin/false" "$log" || fail "ssh askpass was not disabled"
! grep -q "MALICIOUS_AMBIENT" "$log" || fail "malicious ambient environment reached git"
grep -q -- "-c core.hooksPath=$success_home/.hermes/mission-control/runtime/controller-git/empty-hooks" "$log" || fail "git hooks path was not pinned to empty controller hooks"
grep -q -- "-c credential.https://github.com.helper=!$trustedbin/gh auth git-credential" "$log" || fail "credential helper did not use verified absolute gh path"
[[ -f "$success_home/.hermes/mission-control/runtime/controller-git/empty-global-config" ]] || fail "empty global config missing"
[[ -f "$success_home/.hermes/mission-control/runtime/controller-git/empty-system-config" ]] || fail "empty system config missing"
[[ -d "$success_home/.hermes/mission-control/runtime/controller-git/empty-hooks" ]] || fail "empty hooks dir missing"
installed_unit="$success_home/.config/systemd/user/hermes-native-goal-runner.service"
expected_exec="ExecStart=/usr/bin/python3 %h/Documents/GitHub/hermes-mission-control/scripts/hermes_native_goal_runner.py --canonical-repo %h/.hermes/mission-control-source/rt-ops-v2 --expected-origin https://github.com/director-phil/rt-ops-v2.git"
expected_path="Environment=PATH=/usr/bin:/bin:/usr/local/bin"
grep -Fx "$expected_exec" "$installed_unit" >/dev/null || fail "installed unit ExecStart did not match exact reviewed command"
grep -Fx "$expected_path" "$installed_unit" >/dev/null || fail "installed unit PATH did not match exact reviewed environment"
! grep -F "/usr/bin/env" "$installed_unit" >/dev/null || fail "installed unit used /usr/bin/env"
! grep -F "ExecStart=python3 " "$installed_unit" >/dev/null || fail "installed unit used bare python3"
cmp -s "$REPO_DIR/systemd/hermes-native-goal-runner.service" "$installed_unit" || fail "installed unit differs from checked-in reviewed unit"

bad_hermes_home="$tmp/home-bad-hermes"
if run_installer_with_home "$bad_hermes_home" "$hostilebin" "$tmp/bad-hermes.log" "$trustedbin/git" "$trustedbin/gh" "" "missing" >/tmp/hermes-installer-test-bad-hermes.out 2>/tmp/hermes-installer-test-bad-hermes.err; then
  fail "installer accepted missing untrusted Hermes executable"
fi
grep -q "Hermes executable trust preflight failed" /tmp/hermes-installer-test-bad-hermes.err || fail "Hermes trust preflight rejection reason missing"
[[ ! -f "$bad_hermes_home/.config/systemd/user/hermes-native-goal-runner.service" ]] || fail "unit was installed after Hermes trust preflight failure"
[[ ! -f "$tmp/bad-hermes.log" ]] || ! grep -q '^CALL$' "$tmp/bad-hermes.log" || fail "Git mirror refresh ran after Hermes trust preflight failure"

bad_vercel_home="$tmp/home-bad-vercel"
if run_installer_with_home "$bad_vercel_home" "$hostilebin" "$tmp/bad-vercel.log" "$trustedbin/git" "$trustedbin/gh" "" "trusted" "missing-node" >/tmp/hermes-installer-test-bad-vercel.out 2>/tmp/hermes-installer-test-bad-vercel.err; then
  fail "installer accepted missing Vercel Node executable"
fi
grep -q "Vercel executable trust preflight failed" /tmp/hermes-installer-test-bad-vercel.err || fail "Vercel trust preflight rejection reason missing"
[[ ! -f "$bad_vercel_home/.config/systemd/user/hermes-native-goal-runner.service" ]] || fail "unit was installed after Vercel trust preflight failure"
[[ ! -f "$tmp/bad-vercel.log" ]] || ! grep -q '^CALL$' "$tmp/bad-vercel.log" || fail "Git mirror refresh ran after Vercel trust preflight failure"

bad_final_bin="$tmp/bad-final-bin"
bad_final_log="$tmp/bad-final.log"
make_trusted_bin "$bad_final_bin" "$bad_final_log"
chmod 777 "$bad_final_bin/git"
if run_installer_with_home "$tmp/home-bad-final-git" "$hostilebin" "$bad_final_log" "$bad_final_bin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-bad-final-git.out 2>/tmp/hermes-installer-test-bad-final-git.err; then
  fail "installer accepted other-writable trusted Git override"
fi
grep -q "Trusted git executable trust preflight failed" /tmp/hermes-installer-test-bad-final-git.err || fail "other-writable Git rejection reason missing"
[[ ! -f "$bad_final_log" ]] || ! grep -q '^CALL$' "$bad_final_log" || fail "Git ran after other-writable executable rejection"

bad_ancestor_bin="$tmp/bad-ancestor-bin"
bad_ancestor_log="$tmp/bad-ancestor.log"
make_trusted_bin "$bad_ancestor_bin" "$bad_ancestor_log"
chmod 777 "$bad_ancestor_bin"
if run_installer_with_home "$tmp/home-bad-ancestor-git" "$hostilebin" "$bad_ancestor_log" "$bad_ancestor_bin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-bad-ancestor-git.out 2>/tmp/hermes-installer-test-bad-ancestor-git.err; then
  fail "installer accepted Git below other-writable ancestor"
fi
grep -q "Trusted git executable trust preflight failed" /tmp/hermes-installer-test-bad-ancestor-git.err || fail "other-writable ancestor rejection reason missing"
[[ ! -f "$bad_ancestor_log" ]] || ! grep -q '^CALL$' "$bad_ancestor_log" || fail "Git ran after other-writable ancestor rejection"

bad_symlink_target="$tmp/bad-symlink-target"
bad_symlink_bin="$tmp/bad-symlink-bin"
bad_symlink_log="$tmp/bad-symlink-git.log"
make_trusted_bin "$bad_symlink_target" "$bad_symlink_log"
chmod 777 "$bad_symlink_target"
mkdir -p "$bad_symlink_bin"
ln -s "$bad_symlink_target/git" "$bad_symlink_bin/git"
if run_installer_with_home "$tmp/home-bad-symlink-git" "$hostilebin" "$bad_symlink_log" "$bad_symlink_bin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-bad-symlink-git.out 2>/tmp/hermes-installer-test-bad-symlink-git.err; then
  fail "installer accepted Git symlink into other-writable target"
fi
grep -q "Trusted git executable trust preflight failed" /tmp/hermes-installer-test-bad-symlink-git.err || fail "symlink target rejection reason missing"
[[ ! -f "$bad_symlink_log" ]] || ! grep -q '^CALL$' "$bad_symlink_log" || fail "Git ran after symlink target rejection"

make_bad_unit() {
  local name="$1"
  local search="$2"
  local replace="$3"
  local path="$tmp/$name.service"
  sed "s#$search#$replace#" "$REPO_DIR/systemd/hermes-native-goal-runner.service" >"$path"
  printf '%s\n' "$path"
}

bad_env_unit="$(make_bad_unit bad-env '^ExecStart=/usr/bin/python3 ' 'ExecStart=/usr/bin/env python3 ')"
if run_installer_with_home "$tmp/home-bad-env-unit" "$hostilebin" "$tmp/bad-env-unit.log" "$trustedbin/git" "$trustedbin/gh" "$bad_env_unit" >/tmp/hermes-installer-test-bad-env-unit.out 2>/tmp/hermes-installer-test-bad-env-unit.err; then
  fail "/usr/bin/env service unit was accepted"
fi
grep -q "Installed service ExecStart drift" /tmp/hermes-installer-test-bad-env-unit.err || fail "/usr/bin/env rejection reason missing"

bad_bare_unit="$(make_bad_unit bad-bare '^ExecStart=/usr/bin/python3 ' 'ExecStart=python3 ')"
if run_installer_with_home "$tmp/home-bad-bare-unit" "$hostilebin" "$tmp/bad-bare-unit.log" "$trustedbin/git" "$trustedbin/gh" "$bad_bare_unit" >/tmp/hermes-installer-test-bad-bare-unit.out 2>/tmp/hermes-installer-test-bad-bare-unit.err; then
  fail "bare python3 service unit was accepted"
fi
grep -q "Installed service ExecStart drift" /tmp/hermes-installer-test-bad-bare-unit.err || fail "bare python3 rejection reason missing"

bad_args_unit="$(make_bad_unit bad-args ' --expected-origin https://github.com/director-phil/rt-ops-v2.git' '')"
if run_installer_with_home "$tmp/home-bad-args-unit" "$hostilebin" "$tmp/bad-args-unit.log" "$trustedbin/git" "$trustedbin/gh" "$bad_args_unit" >/tmp/hermes-installer-test-bad-args-unit.out 2>/tmp/hermes-installer-test-bad-args-unit.err; then
  fail "missing args service unit was accepted"
fi
grep -q "Installed service ExecStart drift" /tmp/hermes-installer-test-bad-args-unit.err || fail "missing args rejection reason missing"

bad_path_unit="$(make_bad_unit bad-path '^Environment=PATH=/usr/bin:/bin:/usr/local/bin$' 'Environment=PATH=/tmp/evil:/usr/bin:/bin')"
if run_installer_with_home "$tmp/home-bad-path-unit" "$hostilebin" "$tmp/bad-path-unit.log" "$trustedbin/git" "$trustedbin/gh" "$bad_path_unit" >/tmp/hermes-installer-test-bad-path-unit.out 2>/tmp/hermes-installer-test-bad-path-unit.err; then
  fail "unsafe PATH service unit was accepted"
fi
grep -q "Installed service PATH drift" /tmp/hermes-installer-test-bad-path-unit.err || fail "unsafe PATH rejection reason missing"

bad_symlink_home="$tmp/home-symlink"
mkdir -p "$bad_symlink_home/.hermes/mission-control/runtime"
chmod 700 "$bad_symlink_home/.hermes" "$bad_symlink_home/.hermes/mission-control" "$bad_symlink_home/.hermes/mission-control/runtime"
ln -s "$tmp/elsewhere" "$bad_symlink_home/.hermes/mission-control/runtime/controller-git"
if run_installer_with_home "$bad_symlink_home" "$hostilebin" "$tmp/symlink.log" "$trustedbin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-symlink.out 2>/tmp/hermes-installer-test-symlink.err; then
  fail "controller-git symlink was accepted"
fi
grep -q "Controller private path is a symlink" /tmp/hermes-installer-test-symlink.err || fail "symlink rejection reason missing"

bad_config_home="$tmp/home-config"
mkdir -p "$bad_config_home/.hermes/mission-control/runtime/controller-git"
chmod 700 "$bad_config_home/.hermes" "$bad_config_home/.hermes/mission-control" "$bad_config_home/.hermes/mission-control/runtime" "$bad_config_home/.hermes/mission-control/runtime/controller-git"
printf '[url "ssh://evil/"]\n\tinsteadOf = https://github.com/director-phil/\n' >"$bad_config_home/.hermes/mission-control/runtime/controller-git/empty-global-config"
chmod 400 "$bad_config_home/.hermes/mission-control/runtime/controller-git/empty-global-config"
if run_installer_with_home "$bad_config_home" "$hostilebin" "$tmp/config.log" "$trustedbin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-config.out 2>/tmp/hermes-installer-test-config.err; then
  fail "nonempty private Git config was accepted"
fi
grep -q "Controller Git config must be empty" /tmp/hermes-installer-test-config.err || fail "nonempty config rejection reason missing"

bad_hooks_home="$tmp/home-hooks"
mkdir -p "$bad_hooks_home/.hermes/mission-control/runtime/controller-git/empty-hooks"
chmod 700 "$bad_hooks_home/.hermes" "$bad_hooks_home/.hermes/mission-control" "$bad_hooks_home/.hermes/mission-control/runtime" "$bad_hooks_home/.hermes/mission-control/runtime/controller-git"
printf '#!/bin/sh\nexit 1\n' >"$bad_hooks_home/.hermes/mission-control/runtime/controller-git/empty-hooks/pre-commit"
chmod 500 "$bad_hooks_home/.hermes/mission-control/runtime/controller-git/empty-hooks"
if run_installer_with_home "$bad_hooks_home" "$hostilebin" "$tmp/hooks.log" "$trustedbin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-hooks.out 2>/tmp/hermes-installer-test-hooks.err; then
  fail "nonempty private hooks dir was accepted"
fi
grep -q "Controller Git hooks path must be empty" /tmp/hermes-installer-test-hooks.err || fail "nonempty hooks rejection reason missing"

bad_url_http_home="$tmp/home-url-http"
mkdir -p "$bad_url_http_home/.hermes/mission-control-source/rt-ops-v2/.git"
chmod 700 "$bad_url_http_home/.hermes" "$bad_url_http_home/.hermes/mission-control-source" "$bad_url_http_home/.hermes/mission-control-source/rt-ops-v2"
cat >"$bad_url_http_home/.hermes/mission-control-source/rt-ops-v2/.git/config" <<CONFIG
[core]
	repositoryformatversion = 0
[remote "origin"]
	url = $EXPECTED_ORIGIN
	fetch = $EXPECTED_FETCH
[http "https://github.com/"]
	proxy = http://127.0.0.1:9
CONFIG
if run_installer_with_home "$bad_url_http_home" "$hostilebin" "$tmp/url-http.log" "$trustedbin/git" "$trustedbin/gh" >/tmp/hermes-installer-test-url-http.out 2>/tmp/hermes-installer-test-url-http.err; then
  fail "URL-scoped HTTP proxy config was accepted"
fi
grep -q "forbidden Git config present" /tmp/hermes-installer-test-url-http.err || fail "URL-scoped HTTP proxy rejection reason missing"
[[ ! -f "$tmp/url-http.log" ]] || ! grep -q "ARGV=fetch origin main" "$tmp/url-http.log" || fail "fetch was attempted after URL-scoped HTTP proxy config"

echo "installer focused tests passed"
