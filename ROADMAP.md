# CrewSwarm — Ops / Core Roadmap

> Ops and core product work (telemetry, dashboard, validation). Website feature work lives in `website/ROADMAP.md`.

---

## Road to 9/10 — Pre-Beta Checklist

**Goal:** clean, contributor-friendly, regression-protected codebase ready for public beta (`0.1.0-beta`).
**Current state:** 7.5/10 — all features working, naming consistent, Docker ready. Blocked on structure + CI.

### Phase 1 — God-file split ✅ DONE

Extract module boundaries from the three large files. No behavior changes — only move code. Keep entrypoint APIs stable throughout.

**Target files:** `crew-lead.mjs` (5.4k LOC), `gateway-bridge.mjs` (5.4k LOC), `frontend/src/app.js` (5.9k LOC)

**Module boundaries:**

| Module | Path | Extracted from | Status |
|---|---|---|---|
| HTTP routes + handlers | `lib/crew-lead/http-server.mjs` | `crew-lead.mjs` | ✅ |
| Pipeline engine + orchestration | `lib/pipeline/` | `crew-lead.mjs` | ✅ |
| Skill loader + runner | `lib/skills/` | `crew-lead.mjs` | ✅ |
| Agent registry + dispatch | `lib/agents/` | `gateway-bridge.mjs` | ✅ |
| Engine adapters (one file per engine) | `lib/engines/` | `gateway-bridge.mjs` | ✅ |
| Tool executor + permissions | `lib/tools/` | `gateway-bridge.mjs` | ✅ |
| Config + env bootstrap | `lib/runtime/` | both | ✅ |
| Dashboard tab modules | `frontend/src/tabs/` | `frontend/src/app.js` | ✅ |

**Acceptance criteria:**
- ✅ `crew-lead.mjs` and `gateway-bridge.mjs` are orchestration-only shells
- ✅ `app.js` imports from tab modules — no tab logic inline
- ✅ Each module has one clear responsibility, testable in isolation
- ✅ All smoke tests pass unchanged

---

### Phase 2 — Smoke-test CI ✅ DONE

- [x] Add `scripts/smoke.sh` — single script capturing current manual smoke commands
- [x] Add `.github/workflows/smoke.yml` (two jobs: static + integration):
  - `npm ci`
  - `cd frontend && npm run build`
  - `node scripts/health-check.mjs --no-services`
  - `node scripts/check-dashboard.mjs --source-only`
  - `bash install.sh --non-interactive`
- [x] Trigger on PR + push to `main`
- [x] CI green on clean clone

**Acceptance criteria:**
- ✅ CI passes on every push (static + integration both green)
- ✅ Fails fast on runtime regressions (syntax errors, missing deps, broken build)
- ✅ Logs useful for debugging failures (bridge logs dumped on agent connection timeout)

---

### Phase 3 — Beta gate

Do not cut `0.1.0-beta` until all boxes below are checked:

- [x] God-file split complete (Phase 1 done)
- [ ] CI smoke green for 5+ consecutive merges (at 2+ as of 2026-02-27 — watch for 3 more)
- [x] No P0/P1 regressions from `node scripts/health-check.mjs` (10/10 checks pass)
- [x] `install.sh --non-interactive` succeeds on a clean machine
- [x] `README.md` first-run section verified accurate (fixed: config path, engine count, health cmd)
- [ ] `docs/docker.md` tested end-to-end (needs live Docker test)

**When all boxes checked → bump to `0.1.0-beta` and open repo.**

---

## crew-mega Upgrade (user requested 10x improvement)

**Status:** FAILED (QA audit 2026-02-25) — plan was written into wrong project (polymarket ROADMAP); re-implementation belongs here.

### Issues found (QA)
- Phase 1: System prompt not loaded on agent restart
- Phase 2: Skill plugin not registered
- Phase 4: Fallback model not configured
- Phase 5: Brain context entry not added
- Phase 3 (Custom Tools): Optional, skipped

### Re-implementation tasks (CrewSwarm repo / `~/.crewswarm/` only)

- [x] **Phase 1** — crew-mega prompt in `~/.crewswarm/agent-prompts.json` confirmed present.
- [x] **Phase 2** — `~/.crewswarm/skills/polymarket-strategy.json` exists. Skill appears in `/api/skills`.
- [x] **Phase 4** — `fallbackModel: deepseek/deepseek-reasoner` set in `~/.crewswarm/crewswarm.json`.
- [x] **Phase 5** — crew-mega + Polymarket strategy tips added to `memory/brain.md`.

*(User told crew-lead how to make mega 10x better; this is the implementation checklist.)*

---

## Ops / Telemetry

- [x] Field matrix in `docs/OPS-TELEMETRY-SCHEMA.md` — all fields, types, event types documented
- [x] Heartbeat thresholds and task failure windows documented (agent.presence section)
- [x] Event lifecycle guidance — versioning, unknown fields, retry/backoff rules in schema doc
- [x] Sample telemetry bundles — agent.presence, task.lifecycle, error examples with all required fields
- [ ] JSON Schema validation tooling and `scripts/check-dashboard.mjs` payload validation update

---

## Backlog

(Add items here or under new sections.)
