# Hermes Mission Control — Agent Guardrails

Read this before touching any files in this repository.

## Project Identity

This repository is the standalone Hermes Mission Control project.

Expected repo:

```txt
/home/phillip_downs/Documents/GitHub/hermes-mission-control
```

Expected remote:

```txt
https://github.com/director-phil/hermes-mission-control.git
```

## Hard Stop

This project is not `reliable-tradies-ops`.

Do not inspect, modify, build, deploy, import from, or use:

```txt
/home/phillip_downs/Documents/GitHub/reliable-tradies-ops
```

unless Phil explicitly changes the assignment and names that repo.

If your current working directory is not the expected Mission Control repo, stop and report:

```txt
blocked: wrong repo
```

## Required Preflight

Before any edit, run:

```bash
bash scripts/guard-repo.sh
```

The guard must pass before code changes.

## Build Discipline

- Build in vertical slices from the Mission Control v2 issue pack.
- Start with S0 repo/environment guardrail and S1 first-view operating shell.
- Use the existing static concept files as design evidence.
- Do not pull in Reliable Tradies dashboard architecture, database helpers, Railway deployment assumptions, or app-router patterns.
- If a future slice monitors Railway, ServiceTitan, Xero, or other business systems, treat them as external observed systems only, not as the implementation repo.

## Definition of Done

- Correct repo guard passes.
- Files changed are inside `hermes-mission-control` unless the user explicitly asks for vault documentation updates.
- Any vault docs updated are committed separately from app code.
- Verification result is reported honestly.
