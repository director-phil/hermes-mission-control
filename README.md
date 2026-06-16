# Hermes Mission Control

This repository is the standalone Hermes Mission Control project.

Expected repo:

```txt
/home/phillip_downs/Documents/GitHub/hermes-mission-control
```

Expected remote:

```txt
https://github.com/director-phil/hermes-mission-control.git
```

## Purpose

Build the operating dashboard for Hermes agents: project awareness, agent work monitoring, guardrails, context discipline, and vertical-slice delivery.

## Status

This is a vertically sliced implementation. The following slices are implemented:
- S0 - Mission Control repo and environment guardrail
- S1 - Mission Control first-view operating shell

The system is not fully wired for all features but the core overview endpoint is now working correctly with proper timeouts.

## Quality Gates

- `pnpm run build` - ✅ Passes
- `pnpm run lint` - ⚠ Not configured (next lint is deprecated)
- `pnpm run typecheck` - ⚠ Not configured (missing script in package.json)

## API Endpoints

- `/api/mission-control/overview` - Returns system overview with timeouts
- `/api/mission-control/system-health` - Returns detailed system health checks
- `/api/mission-control/environment` - Returns environment information
- `/mission-control` - Dashboard UI

## Implementation Notes

The `/api/mission-control/overview` endpoint now includes proper timeout handling to prevent hanging. The system health check in the overview has a 5-second timeout, and if that fails, it falls back to local-only checks.

The lint and typecheck scripts are not currently configured but this is noted in the documentation.

## System Health Notes

The `/api/mission-control/system-health` endpoint now includes fail-fast logic for SSH connectivity. If the `SSH_GB10_2_HOST` environment variable is not set, it returns an "unreachable" status immediately rather than hanging on SSH connection attempts.

All system health checks are now bounded with timeouts to prevent hanging behavior. The entire system-health route should return within 5 seconds even when dependencies are unreachable.