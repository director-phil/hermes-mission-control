# Hermes Native Goal Runtime

The Hermes Native Goal Runtime is the execution substrate for autonomous goal
dispatch in Mission Control. It uses explicit native Hermes stage profiles
orchestrated by a single-process controller with atomic state transitions.

Default stage profiles are safe and configurable:

- Plan: `default`, a Codex-backed profile.
- Code implementation: `default`, a Codex-backed profile.
- Final review: `default`, a Codex-backed profile.

The `HERMES_NATIVE_PLAN_PROFILE`, `HERMES_NATIVE_CODE_PROFILE`, and
`HERMES_NATIVE_REVIEW_PROFILE` environment variables can pin compatible
profiles. Plan, code, and final review resolve the configured Hermes profile provider
with `hermes --profile <profile> config get model.provider` before work starts
and fail closed unless the provider is exactly `openai-codex`.

## Goal Schema

Goals are Markdown files placed in `~/.hermes/mission-control/runtime/goals/staged/`
or `ready/`. Migrated goals enter `staged/` first. The controller promotes
exactly one dependency-ready, non-hard-stopped staged goal at a time, prepares a
fresh isolated checkout, rewrites `repo/workdir` to that checkout, and only then
moves the goal to `ready/`.

Goal `repo/workdir` values must point at Git worktrees under
`~/.hermes/mission-control-worktrees/`. The native runtime root itself is never
a valid code worktree, and both `~/Documents/GitHub/reliable-tradies-ops` and
`~/Documents/GitHub/reliable-tradies-ops-v2` are explicit forbidden roots.

### Frontmatter (required)

```yaml
---
title: <goal title>
repo/workdir: <path to git worktree>
dependencies: <comma-separated goal IDs, or empty>
hard_stop: <true only when the goal must not promote>
branch_kind: <feat or fix>
vercel_impact: <true when Vercel deployment evidence is required>
surface_verification: <true only when deterministic surface verification is automated>
allowed_files: <comma-separated repo-relative paths, optional only when section form is used>
---
```

Accepted scalar keys are exactly:

- `title`
- `repo/workdir` or `worktree`
- `dependencies`
- `depends_on` or `dependency_ids` as migration aliases for `dependencies`;
  scalar, comma-separated, inline list, or YAML-like list
- `hard_stop`
- `branch_kind`
- `vercel_impact`
- `surface_verification`
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
`/usr/bin/bash -e -u -o pipefail -s` in a fixed minimal environment, with the
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
│   ├── staged/     # Migrated goals waiting for dependency release
│   ├── ready/      # Goals waiting to be claimed
│   ├── running/    # Currently executing (one at a time)
│   ├── done/       # Successfully completed
│   ├── failed/     # Failed goals
│   └── changed_pending_surface_verification/
│                   # Shipped code whose visual/authenticated surface could not be automated
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

1. **Ready block checks**: Parse the next `ready/` goal. If `hard_stop: true`, leave it in `ready/`, emit non-terminal `promotion.blocked` and `goal.blocked` evidence, and continue without dependency release, controller lock creation, or model calls.
2. **Lock**: Create controller lock with `O_EXCL`.
3. **Claim**: Atomically move goal from `ready/` to `running/` via `os.replace()`.
4. **Plan**: Run `hermes --profile "${HERMES_NATIVE_PLAN_PROFILE:-default}" chat --query-file - --source mission-control-goal-plan` with the prompt supplied on stdin.
   Goal markdown is treated as untrusted data. The model prompt separates controller authority/stage instructions from a bounded serialized goal-data envelope. The envelope preserves title, worktree, allowed files, model-visible requirements, and the acceptance SHA-256, but excludes the raw Acceptance section and shell body.
   Before invocation, the controller captures a full worktree fingerprint covering staged, unstaged, untracked, and ignored state plus a Git control-plane fingerprint. Immediately after the planner returns, both fingerprints must match and origin/control-plane validation must still pass before `PLAN_APPROVED` can be accepted. Any planner mutation fails closed as `planner_mutated_worktree` or `planner_mutated_control_plane`, and no implementation, review, or shipping stage is invoked.
   Requires bounded stdout, stripped of surrounding whitespace, to equal exactly `PLAN_APPROVED`.
5. **Code**: Run `hermes --profile "${HERMES_NATIVE_CODE_PROFILE:-default}" chat --query-file - --source mission-control-goal-code` with the prompt supplied on stdin.
   The prompt states Codex-only production implementation authority, names the exact controller markers, and reserves those markers for plan/final review.
   Requires exit 0 and substantive git diff within allowed files.
6. **Scope Check**: Verify all staged, unstaged, and untracked changed files are in the allowed list. Reject binary/NUL diffs, including direct NUL inspection of every untracked allowed path because untracked files are absent from `git diff --numstat`.
7. **Acceptance**: Execute the bash acceptance block with minimal env, passing the byte-preserved body on stdin. The raw acceptance shell is controller-only: it is hashed for model-visible evidence and execution records, but is never sent to planner, code, or review prompts.
8. **Post-acceptance Scope Check**: Re-run the full scope check immediately after acceptance and before review. Any staged, unstaged, untracked, or binary/NUL violation fails closed.
9. **Review**: Run `hermes --profile "${HERMES_NATIVE_REVIEW_PROFILE:-default}" chat --query-file - --source mission-control-goal-review` with the prompt supplied on stdin.
   The prompt states Codex-only final code review authority and the exact required marker.
   Requires bounded stdout, stripped of surrounding whitespace, to equal exactly `REVIEW_PASS`.
10. **Post-review Scope Check**: Re-run the full scope check immediately after review and before shipping. Review is read-only: any diff fingerprint mutation by review fails closed even if the changed path is in-scope. There is no repair stage in this runtime.
11. **Finalize**: Move to `done/` or `failed/`, write terminal result JSON, emit the terminal event, then clean the owned lock. If the terminal move fails, the runner records non-terminal recovery evidence, preserves the lock/running file, and does not emit a false terminal event.

Dependency release requires both `goals/done/<goal-id>.md` and
`runs/<goal-id>/result.json` with `success: true`. Historical dependencies
created by migration must use `provenance: migrated_historical`; this releases
dependents without claiming the native runner executed the work. Failed,
pending-surface, malformed, or missing parents do not release child goals.

Promotion is global single-flight. The promoter takes `promotion.lock` with
goal/controller-style owner metadata: PID, process start ticks, creation time,
and purpose. Before acquisition, an existing holder is checked against `/proc`;
live holders block promotion, while dead or PID-reused holders are removed with
directory fsync and global recovery evidence in `controller-events.jsonl`.
Cleanup removes the lock only when it is still owned by the current PID/start
ticks. After lock acquisition, promotion safely recovers stale controller state,
recovers orphan `running/` files back to
`ready/` only when no controller lock exists, then scans `ready/` and
`running/`. Any valid non-terminal goal in those directories blocks promotion,
even without `controller.lock`; malformed active files fail closed with
controller warning evidence instead of being ignored. Duplicate goal IDs across
native state directories block claim with non-terminal integrity evidence.
The specific staged+ready crash case is recovered only when both files parse as
the same promotion; otherwise the conflicting files are quarantined.

## One-Shot Migration

Migration is an explicit operator action and is not part of steady-state
runtime execution:

```bash
python3 scripts/hermes_native_goal_runner.py \
  --migrate-legacy \
  --legacy-source-root /path/to/preserved/legacy/ledger \
  --native-root ~/.hermes/mission-control/runtime \
  --canonical-repo ~/.hermes/mission-control-source/rt-ops-v2 \
  --expected-origin https://github.com/director-phil/rt-ops-v2.git \
  --exclude-regex 'ringcentral|podium'
```

The migration input root, native root, and canonical repo are fixed by explicit
CLI arguments and validated by realpath with symlink rejection. For this queue,
the only accepted canonical target is
`~/.hermes/mission-control-source/rt-ops-v2` with origin
`https://github.com/director-phil/rt-ops-v2.git`; a Mission Control checkout or
wrong origin fails closed. The source is read only. File count, per-file bytes,
and total bytes are bounded. Legacy goals without a valid frontmatter contract,
exact `## Acceptance` bash fence, or Allowed files are recorded in
`migration-report.json` as skipped and are not made executable.

Preserved done goals become native historical dependencies only when an actual
`## Result` or `## Evidence` section contains positive merged/shipped
verification plus a concrete PR URL, PR number, or merge SHA. Sections with
negated, failed, blocked, held, pending, or raw-data hard-stop language fail
closed. Duplicate legacy path stems are quarantined before migration writes:
neither copy is imported as staged or done, and `migration-report.json` records
one deterministic duplicate entry with both relative source paths. Historical
records are marked `migrated_historical`. No success is inferred from directory
placement or frontmatter status alone. RingCentral SMS and Podium can remain
excluded with `--exclude-regex` or by using explicit `--ids`.

Before writing a migrated goal, migration scans every native state directory
and `runs/<goal-id>`. Any existing authority for that ID is reported under
`collisions` with deterministic relative locations, and no migrated goal,
result, or event authority is written for that ID. Goal files use no-clobber
creation. Historical done migration claims `runs/<goal-id>` exclusively, writes
result and event evidence first, and writes the `done/` goal last so a false
done goal cannot appear without result evidence.

Runtime truth treats duplicate native goal IDs across state directories as an
integrity failure. Such IDs are surfaced as `conflicted` with only state/path
metadata and a critical warning; they are not collapsed into one surviving
ready, running, or terminal goal.

## Fresh Checkouts

Promotion uses a bounded checkout root:

```txt
~/.hermes/mission-control-worktrees/<goal-id>/
```

The canonical repo must be the dedicated clean mirror
`~/.hermes/mission-control-source/rt-ops-v2` and must have origin
`https://github.com/director-phil/rt-ops-v2.git`. Promotion never reuses an
existing final checkout path: if the per-goal destination already exists as a
file, directory, or symlink, promotion fails closed and requires separate
verified cleanup. New promoted checkouts clone from the GitHub origin URL into a
unique temporary sibling under the bounded checkout root. The clean mirror is
validated as source-of-truth/readiness evidence only; it is not used as clone
transport and is never passed as a Git object alternate. The runner
rejects destination and ancestor symlinks before running Git against that path,
then verifies realpath containment after clone and after publishing. Each
temporary checkout fetches `origin/main`, checks out a neutral branch, and must
have no tracked, untracked, or ignored artifacts before it is atomically renamed
into the final destination with no-clobber semantics. On any failure after the
runner creates a checkout temp directory, cleanup removes only that exact owned
directory after containment, identity, and non-symlink checks; replaced paths or
symlinks are left for operator inspection and reported as containment failure:

```txt
feat/native-<goal-id>
fix/native-<goal-id>
```

The controller validates the canonical mirror with read-only Git commands and
`GIT_OPTIONAL_LOCKS=0`, then fails closed on dirty canonical mirror state, dirty
promoted checkout state, ignored artifacts, origin mismatch, forbidden roots,
pre-existing final checkout paths, leftover checkout temp directories, or paths
outside the dedicated worktree root. The primary checkout at
`~/Documents/GitHub/reliable-tradies-ops-v2` is the human/WIP checkout and is
never used, reset, cleaned, or treated as the runner source or an allowed
worktree. Implementation happens in the dedicated per-goal checkout.

After checkout preparation, promotion writes the rewritten Markdown to an
exclusive temp file in `staged/`, fsyncs the file and directory, replaces the
staged file with the rewritten bytes, then atomically moves that file into
`ready/`. This keeps exactly one authoritative goal file across staged and ready
except for the explicitly recovered staged+ready crash case above.

## Shipping Gates

Review pass is no longer terminal success. After final review, the runner:

1. Captures the authoritative reviewed diff fingerprint immediately after the
   final read-only `REVIEW_PASS` check.
2. Re-runs deterministic acceptance in the actual checkout.
3. Requires the post-acceptance-rerun diff fingerprint to exactly match the
   reviewed fingerprint passed into shipping. Any allowed or disallowed content
   change fails closed as `post_review_acceptance_mutated_diff` before
   `git add`, commit, push, PR creation, or merge.
4. Re-runs the full scope check immediately after acceptance rerun and before any
   `git add --all`. Any staged, unstaged, untracked, or binary/NUL violation
   fails closed.
5. Commits with the approved `director-phil` identity.
6. Pushes the neutral branch with `git push origin <branch>` and no upstream or
   tracking mutation. The Git control-plane fingerprint must remain unchanged
   after push.
7. Creates a GitHub PR with `gh`.
8. Records PR URL hash, PR number, pre-squash head SHA, check status, merge
   status, and origin/main containment metadata.
9. Requires every PR view to use the explicit PR number and to show
   `headRefOid` exactly equal to the reviewed local commit SHA. It checks this
   immediately after PR creation, after required checks complete, and
   immediately before merge; the PR must remain open with no changes requested.
10. Merges the explicit PR number with expected-head semantics and then reads
   `gh pr view <number> --json number,state,headRefOid,mergedAt,mergeCommit,url`,
   requiring the same PR number, same head SHA, `MERGED`, a merge timestamp, and
   a valid merge commit SHA. It fetches `origin/main` and verifies `origin/main`
   contains that merge SHA. This supports normal squash merges.
11. For Vercel-impacting goals, uses GitHub deployments/status API for the exact
   merge SHA. For each exact Production deployment, it selects the latest status
   deterministically by `created_at` or `updated_at`; if timestamps are absent,
   it falls back to the GitHub API's newest-first order. The latest status must
   be `success` with a valid HTTPS environment URL, then the runner executes
   `vercel inspect <environment_url> --logs`.

`done/` means shipped and verified. A local diff, acceptance pass, or review
pass alone cannot produce `done/`. The controller does not own browser/visual
surface verification, so every Vercel-impacting goal moves to
`changed_pending_surface_verification/` with `success: false` after exact
deployment/log verification, regardless of `surface_verification`. A separate
trusted verifier can later promote with evidence. Non-Vercel goals may become
`done/` after all other shipping gates pass.
Shipping commands with output markers such as `FAILED` or `NOT verified` fail
closed.

JSON and JSONL writes create parent directories durably: newly-created
directories, appended files, atomic replacements, and containing directories are
fsynced. On supported Linux filesystems, fsync failure is treated as an I/O
failure rather than as proven durability.

## Install

```bash
bash scripts/install-hermes-native-goal-runner.sh
```

This copies the checked-in systemd unit to `~/.config/systemd/user/` and creates
the runtime directories, including `staged/` and
`changed_pending_surface_verification/`, plus
`~/.hermes/mission-control-worktrees/`. It does NOT start the service.

The installer also prepares the dedicated canonical mirror at
`~/.hermes/mission-control-source/rt-ops-v2`. It creates the parent directory,
clones `https://github.com/director-phil/rt-ops-v2.git` only when the mirror is
absent, validates any existing mirror is a non-symlink standalone Git repo with
the exact origin and clean status, fetches `origin main`, then checks out and
resets the mirror to `origin/main`. A dirty or wrong-origin mirror fails closed;
the installer does not clean, reset, or delete local work. It never touches the
primary WIP checkout under `~/Documents/GitHub/reliable-tradies-ops-v2`.

All installer Git operations run through a controller-private Git environment
under `~/.hermes/mission-control/runtime/controller-git`. The installer rejects
symlinks, wrong owners, wrong modes, non-empty private config files, and non-empty
hooks directories; uses empty system/global config files and an empty hooks path;
disables prompts and askpass; invokes only verified absolute `git`/`gh`
executables from the controller allow-list; uses a fixed child `PATH`; strips
ambient Git/SSH/proxy/credential environment; rejects local `http.*` and
`https.*` transport config; and revalidates the exact HTTPS origin and local Git
control-plane settings around mirror refresh operations. Any invalid
pre-existing private path or Git config state fails closed.

The native runner applies the same fixed external-command environment to
production `git`, `hermes`, `gh`, and `vercel` invocations. Managed command names
are resolved to verified absolute executables before execution; missing,
symlinked, wrong-owner, or otherwise untrusted binaries fail closed.

For the host Hermes editable install, user-owned group-writable files and
directories are trusted only under the explicit private-primary-group contract:
owner UID must be the current UID, group GID must be the current primary GID,
no other passwd account may use that primary GID, the primary group must have no
supplementary members, and other-write must be absent. The runner validates the
wrapper, resolved symlink parents and targets, venv entrypoint, interpreter,
editable `site-packages` marker/finder metadata, and `hermes_cli` source
package chain. The installer runs the same runner preflight before mirror
refresh or unit copy, so an installer pass implies stage command resolution can
find a trusted Hermes executable.

The checked-in systemd unit invokes the runner with:

```txt
--canonical-repo %h/.hermes/mission-control-source/rt-ops-v2 --expected-origin https://github.com/director-phil/rt-ops-v2.git
```

The installer verifies the copied unit still carries those explicit V2 target
arguments.

The systemd unit keeps `~/Documents/GitHub` and the canonical mirror read-only.
Only `~/.hermes/mission-control/runtime` and
`~/.hermes/mission-control-worktrees` are writable to the long-running runner.

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
2. Old execution services stay stopped and disabled; do not re-enable or start them.
3. Native state in `~/.hermes/mission-control/runtime/` is preserved read-only.

## Evidence Paths

- **Goal state**: `~/.hermes/mission-control/runtime/goals/{staged,ready,running,done,failed,changed_pending_surface_verification}/`
- **Events**: `~/.hermes/mission-control/runtime/runs/<goal-id>/events.jsonl`
- **Results**: `~/.hermes/mission-control/runtime/runs/<goal-id>/result.json`
- **Locks**: `~/.hermes/mission-control/runtime/controller.lock`, `~/.hermes/mission-control/runtime/promotion.lock`
- **Langfuse**: Metadata-only traces linked by goal/session IDs (content capture disabled).

Runtime-truth observability treats both manual
`scripts/hermes_native_goal_runner.py` processes and
`hermes-native-goal-runner.service` processes as controller evidence. Systemd
unit attribution remains preserved in process metadata while controller counts
use the process role.

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
