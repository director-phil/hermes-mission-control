# Hermes Native Goal Runtime

The Hermes Native Goal Runtime replaces ChatDev as the execution substrate for
autonomous goal dispatch in Mission Control. It uses native Hermes profiles
(`reviewer` for planning/review, `coder` for implementation) orchestrated by a
single-process controller with atomic state transitions.

## Goal Schema

Goals are Markdown files placed in `~/.hermes/mission-control/runtime/goals/ready/`.
Goal `repo/workdir` values must point at Git worktrees under
`~/.hermes/mission-control-worktrees/`. The native runtime root itself is never
a valid code worktree, and `~/Documents/GitHub/reliable-tradies-ops` remains an
explicit forbidden root.

### Frontmatter (required)

```yaml
---
title: <goal title>
repo/workdir: <path to git worktree>
dependencies: <comma-separated goal IDs, or empty>
allowed_files: <comma-separated repo-relative paths, optional only when section form is used>
---
```

Accepted scalar keys are exactly:

- `title`
- `repo/workdir` or `worktree`
- `dependencies`
- `allowed_files`

### Body

The body contains the goal description and must include an `## Acceptance` section
with a fenced bash block:

```markdown
## Acceptance

```bash
python3 -m py_compile scripts/example.py
python3 scripts/example.py --self-test
```
```

The acceptance body is preserved byte-for-byte and executed with
`/usr/bin/bash -e -u -o pipefail -s` in a minimal environment, with the
acceptance body supplied on stdin rather than argv or environment.

### Allowed Files (required)

Every goal must provide a non-empty allowed-file allow-list. It can be supplied
as the `allowed_files` frontmatter scalar above, as this Markdown section, or
both. Paths are repo-relative files or directories. An empty allow-list blocks
all changes and the runner quarantines the goal before invoking any model.

```markdown
## Allowed files

- `scripts/example.py`
- `docs/example.md`
```

Accepted section schema is exactly a `## Allowed files` or `### Allowed files`
heading followed by `- path` or ``- `path` `` bullets. Other prose is ignored.

## State Directories

```
~/.hermes/mission-control/runtime/
├── goals/
│   ├── ready/      # Goals waiting to be claimed
│   ├── running/    # Currently executing (one at a time)
│   ├── done/       # Successfully completed
│   └── failed/     # Failed goals
├── runs/
│   └── <goal-id>/
│       ├── events.jsonl   # Ordered metadata-only events
│       └── result.json    # Terminal result record
└── controller.lock        # O_EXCL PID/start-ticks lock
```

## Controller Lock

- Created with `O_CREAT|O_EXCL` — never overwrites an existing lock.
- Contains `{goal_id, pid, proc_start_ticks, created_at}`.
- Validated by reading `/proc/<pid>/stat` and comparing start ticks.
- Cleaned up only if still owned by the same goal+PID+start_ticks.

## Lifecycle

1. **Lock**: Create controller lock with `O_EXCL`.
2. **Claim**: Atomically move goal from `ready/` to `running/` via `os.replace()`.
3. **Plan**: Run `hermes --profile reviewer chat --query-file - --source mission-control-goal-plan` with the prompt supplied on stdin.
   Requires bounded stdout, stripped of surrounding whitespace, to equal exactly `PLAN_APPROVED`.
4. **Code**: Run `hermes --profile coder chat --query-file - --source mission-control-goal-code` with the prompt supplied on stdin.
   Requires exit 0 and substantive git diff within allowed files.
5. **Scope Check**: Verify all changed files are in the allowed list. Reject binary/NUL diffs, including direct NUL inspection of every untracked allowed path because untracked files are absent from `git diff --numstat`.
6. **Acceptance**: Execute the bash acceptance block with minimal env, passing the byte-preserved body on stdin.
7. **Review**: Run `hermes --profile reviewer chat --query-file - --source mission-control-goal-review` with the prompt supplied on stdin.
   Requires bounded stdout, stripped of surrounding whitespace, to equal exactly `REVIEW_PASS`.
8. **Finalize**: Move to `done/` or `failed/`, write terminal result JSON, emit the terminal event, then clean the owned lock. If the terminal move fails, the runner records non-terminal recovery evidence, preserves the lock/running file, and does not emit a false terminal event.

Dependency release requires both `goals/done/<goal-id>.md` and
`runs/<goal-id>/result.json` with `success: true`. Failed or missing parents do
not release child goals.

JSON and JSONL writes create parent directories durably: newly-created
directories, appended files, atomic replacements, and containing directories are
fsynced. On supported Linux filesystems, fsync failure is treated as an I/O
failure rather than as proven durability.

## Install

```bash
bash scripts/install-hermes-native-goal-runner.sh
```

This copies the checked-in systemd unit to `~/.config/systemd/user/` and creates
the runtime directories plus `~/.hermes/mission-control-worktrees/`. It does NOT
start the service.

The systemd unit keeps source checkouts under `~/Documents/GitHub` read-only.
Only `~/.hermes/mission-control/runtime` and
`~/.hermes/mission-control-worktrees` are writable to the runner.

## Start

```bash
systemctl --user start hermes-native-goal-runner.service
```

## Stop

```bash
systemctl --user stop hermes-native-goal-runner.service
```

## Rollback

1. Stop the native runner:
   ```bash
   systemctl --user stop hermes-native-goal-runner.service
   systemctl --user disable hermes-native-goal-runner.service
   ```
2. ChatDev services remain untouched and continue operating.
3. Native state in `~/.hermes/mission-control/runtime/` is preserved read-only.

## Evidence Paths

- **Goal state**: `~/.hermes/mission-control/runtime/goals/{ready,running,done,failed}/`
- **Events**: `~/.hermes/mission-control/runtime/runs/<goal-id>/events.jsonl`
- **Results**: `~/.hermes/mission-control/runtime/runs/<goal-id>/result.json`
- **Lock**: `~/.hermes/mission-control/runtime/controller.lock`
- **Langfuse**: Metadata-only traces linked by goal/session IDs (content capture disabled).

## Self-Test

```bash
python3 scripts/hermes_native_goal_runner.py --self-test
```

Runs a fully synthetic test suite proving all lifecycle and failure paths
without any model/network calls.

## Privacy

- No raw prompts, model responses, file bodies, stdout, or stderr are stored
  in events, results, state, or JSONL.
- Only metadata is recorded: exit codes, durations, byte counts, markers, SHA-256.
- Langfuse content and tool I/O capture are explicitly disabled.
