# Repo Reorg Migration

This document defines the target repo layout, the exact directory moves to get there, what is likely to break at each step, and the lowest-risk first phase.

The goal is to make `crewswarm` easier to navigate and release without changing product behavior during the early cleanup phases.

## Target layout

```text
crewswarm/
  apps/
    dashboard/      # current frontend/
    vibe/           # current studio/
    crewchat/       # native macOS app source + build assets
  packages/
    core/           # current lib/ and shared runtime code
    crew-cli/       # current crew-cli/
  services/
    crew-lead/      # current crew-lead.mjs and related entrypoint glue
    gateway/        # current gateway-bridge.mjs and related bridge startup
    bridges/        # telegram, whatsapp, mcp, optional external bridges
  scripts/
    dev/
    ops/
    release/
    smoke/
  tests/
    unit/
    integration/
    e2e/
    legacy/
  docs/
    CANONICAL/
    archive/
  contrib/
  docker/
```

## Product boundary

This is the clean target product model:

- `crewswarm` = umbrella repo and runtime platform
- `dashboard` = control plane app
- `vibe` = IDE app
- `crewchat` = native chat client
- `crew-cli` = standalone CLI package
- `crew-lead` = orchestration/chat service
- `gateway` = agent execution bridge

## Standalone reality

Current practical boundaries:

- `vibe` can run standalone for:
  - local project storage
  - local file editing
  - local CLI passthrough
- `vibe` still depends on the swarm for:
  - direct agent chat
  - `crew-lead` chat
  - dashboard-backed agent/project state
- `crew-cli` should remain a standalone installable package
- `crewchat` is currently a client for dashboard + `crew-lead`, not a true standalone product
- `dashboard` is the swarm control plane, not a standalone end-user app

## Exact directory moves

### Move set A: low-risk root cleanup

These moves do not change the runtime architecture. They mainly reduce root clutter.

- move root `test-*.mjs`, `test-*.sh`, `test-*.js`, and `test suite.js` into an archive bucket, not the active test tree
- move root ad hoc utility scripts into `scripts/dev/` or `scripts/ops/`
- move local/generated output dirs into a clearer internal bucket only if they are not runtime-critical:
  - `orchestrator-logs/`
  - `qa-output/`
  - `docs/images/release-screenshots/`
- move backup files into archive/internal buckets:
  - `CrewChat-v2-backup.swift`
  - `telegram-bridge.mjs.backup`

### Move set B: app directory normalization

- `frontend/` -> `apps/dashboard/`
- `studio/` -> `apps/vibe/`
- create `apps/crewchat/`
  - move `CrewChat.swift`
  - move `build-crewchat.sh`
  - move crewchat-specific build helpers from `scripts/`

### Move set C: package/service normalization

- `crew-cli/` -> `packages/crew-cli/`
- `lib/` -> `packages/core/`
- create `services/crew-lead/`
  - move `crew-lead.mjs`
- create `services/gateway/`
  - move `gateway-bridge.mjs`
- create `services/bridges/`
  - move:
    - `telegram-bridge.mjs`
    - `whatsapp-bridge.mjs`
    - MCP or other sidecar entrypoints now in `scripts/`

### Move set D: script reshaping

- `scripts/restart-dashboard.sh` -> `scripts/ops/restart-dashboard.sh`
- `scripts/smoke.sh` -> `scripts/smoke/smoke.sh`
- `scripts/smoke-surfaces.sh` -> `scripts/smoke/smoke-surfaces.sh`
- `scripts/start-crew.mjs` -> `scripts/ops/start-crew.mjs`
- `scripts/dashboard.mjs` stays where it is initially, then later either:
  - `services/dashboard/server.mjs`, or
  - `apps/dashboard/server.mjs`

## What breaks per move

### If `frontend/` moves to `apps/dashboard/`

Likely breakpoints:

- root `package.json` scripts
- any docs that say `cd frontend`
- `scripts/dashboard.mjs` static asset serving if it references `frontend/dist`
- smoke scripts that check `frontend/dist/index.html`
- CI/release scripts

Files likely to break:

- `package.json`
- `scripts/dashboard.mjs`
- `scripts/smoke.sh`
- docs that mention `frontend/`

### If `studio/` moves to `apps/vibe/`

Likely breakpoints:

- root npm scripts for `vibe`, `studio:*`
- `start-studio.sh`
- SwiftBar / dashboard service controls
- Playwright e2e harness paths
- standalone build and watch-server scripts

Files likely to break:

- `package.json`
- `start-studio.sh`
- `scripts/dashboard.mjs`
- `contrib/swiftbar/openswitch.10s.sh`
- `tests/e2e/studio-test-utils.js`
- docs that mention `studio/`

### If `crew-cli/` moves to `packages/crew-cli/`

Likely breakpoints:

- dashboard CLI spawn fallbacks
- docs and scripts that `cd crew-cli`
- build and QA scripts inside root
- MCP / engine wrapper assumptions

Files likely to break:

- `scripts/dashboard.mjs`
- `package.json`
- `AGENTS.md`
- crew-cli docs and internal scripts

### If `lib/` moves to `packages/core/`

This is the highest import-churn move.

Likely breakpoints:

- nearly all runtime imports
- tests
- scripts
- CLI shared code references

Files likely to break:

- `scripts/dashboard.mjs`
- `crew-lead.mjs`
- `gateway-bridge.mjs`
- `test/**/*.mjs`
- `tests/**/*.js`
- `crew-cli/**`

### If `crew-lead.mjs` or `gateway-bridge.mjs` moves

Likely breakpoints:

- service restart/start scripts
- dashboard service buttons
- docs
- direct shell invocations
- health checks

Files likely to break:

- `scripts/dashboard.mjs`
- `scripts/restart-dashboard.sh`
- `scripts/start-crew.mjs`
- `contrib/swiftbar/openswitch.10s.sh`
- canonical docs and AGENTS docs

## Lowest-risk phase 1 — COMPLETE (2026-04-03)

Phase 1 is complete. Root clutter reduced, tests reorganized, backup files archived, canonical docs updated.

### Phase 1 goals

- reduce root clutter
- make tests easier to find
- make public repo shape cleaner
- keep all service paths stable

### Phase 1 exact moves

1. create an archive bucket for legacy root tests
2. move root standalone test files into the archive bucket
3. create `scripts/dev/` and `scripts/smoke/`
4. move non-critical ad hoc helper scripts into those buckets
5. move backup files and obvious one-offs out of root
6. update canonical docs and smoke commands to point at the new paths

### Phase 1 should NOT move yet

- `frontend/`
- `studio/`
- `crew-cli/`
- `lib/`
- `crew-lead.mjs`
- `gateway-bridge.mjs`

### Phase 1 files to patch

- `package.json`
- `docs/CANONICAL/TESTING.md`
- `docs/CANONICAL/README.md`
- any smoke or CI scripts that reference moved test files

## Phase 2 — COMPLETE (2026-04-03)

Phase 2 is complete. `studio/` → `apps/vibe/`, `frontend/` → `apps/dashboard/`, `apps/crewchat/` created. All service paths stable and runtime verified.

Recommended order (completed):

1. `studio/` -> `apps/vibe/` ✓
2. `frontend/` -> `apps/dashboard/` ✓
3. create `apps/crewchat/` ✓

This is enough to make the repo look far more conventional without immediately triggering a full core import migration.

## Phase 3

Move package/service internals:

1. `crew-cli/` -> `packages/crew-cli/`
2. `lib/` -> `packages/core/`
3. service entrypoints into `services/`

This phase has the highest churn and should only happen after Phase 1 and 2 are stable with passing smoke and e2e.

## Release gate after each phase

Run at minimum:

```bash
bash scripts/smoke.sh --no-build
bash scripts/smoke-surfaces.sh
npx playwright test tests/e2e
```

For any phase that moves runtime code, also verify:

- dashboard starts
- `crew-lead` starts
- vibe starts
- crewchat connects
- SwiftBar actions still work

## Recommendation

Do Phase 1 immediately.

Do not start with a full rename or `lib/` move. That is the fastest way to turn a cleanup into a breakage project.
