# CrewSwarm — Ops / Core Roadmap

> Ops and core product work (telemetry, dashboard, validation). Website feature work lives in `website/ROADMAP.md`.

---

## Road to 9/10 — Pre-Beta Checklist

**Goal:** clean, contributor-friendly, regression-protected codebase ready for public beta (`0.1.0-beta`).
**Current state:** 7.5/10 — all features working, naming consistent, Docker ready. Blocked on structure + CI.

### Phase 1 — God-file split

Extract module boundaries from the three large files. No behavior changes — only move code. Keep entrypoint APIs stable throughout.

**Target files:** `crew-lead.mjs` (5.4k LOC), `gateway-bridge.mjs` (5.4k LOC), `frontend/src/app.js` (5.9k LOC)

**Module boundaries:**

| Module | Path | Extracted from |
|---|---|---|
| HTTP routes + handlers | `lib/http/` | `crew-lead.mjs` |
| Pipeline engine + orchestration | `lib/pipeline/` | `crew-lead.mjs` |
| Skill loader + runner | `lib/skills/` | `crew-lead.mjs` |
| Agent registry + dispatch | `lib/agents/` | `gateway-bridge.mjs` |
| Engine adapters (one file per engine) | `lib/engines/` | `gateway-bridge.mjs` |
| Tool executor + permissions | `lib/tools/` | `gateway-bridge.mjs` |
| Config + env bootstrap | `lib/runtime/` | both |
| Dashboard tab modules | `frontend/src/tabs/` | `frontend/src/app.js` |

**Process per slice:**
- [ ] Create module file with extracted code
- [ ] Update entrypoint to import from new module
- [ ] Verify smoke tests still pass
- [ ] Commit

**Acceptance criteria:**
- `crew-lead.mjs` and `gateway-bridge.mjs` are orchestration-only shells
- `app.js` imports from tab modules — no tab logic inline
- Each module has one clear responsibility, testable in isolation
- All smoke tests pass unchanged

---

### Phase 2 — Smoke-test CI

- [ ] Add `scripts/smoke.sh` — single script capturing current manual smoke commands
- [ ] Add `.github/workflows/smoke.yml`:
  - `npm ci`
  - `cd frontend && npm run build`
  - `node scripts/health-check.mjs --no-services`
  - `node scripts/check-dashboard.mjs --source-only`
  - `bash install.sh --non-interactive`
- [ ] Trigger on PR + push to `main`
- [ ] Verify CI green on clean clone

**Acceptance criteria:**
- CI passes on every push
- Fails fast on runtime regressions (syntax errors, missing deps, broken build)
- Logs useful for debugging failures

---

### Phase 3 — Beta gate

Do not cut `0.1.0-beta` until all boxes below are checked:

- [ ] God-file split complete (Phase 1 done)
- [ ] CI smoke green for 5+ consecutive merges
- [ ] No P0/P1 regressions from `node scripts/health-check.mjs`
- [ ] `install.sh --non-interactive` succeeds on a clean machine
- [ ] `README.md` first-run section verified accurate
- [ ] `docs/docker.md` tested end-to-end

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

- [ ] **Phase 1** — crew-main: Update `~/.crewswarm/agent-prompts.json` → `crew-mega` key with full prompt. Acceptance: crew-mega shows new prompt after bridge restart.
- [x] **Phase 2** — crew-coder: Create `~/.crewswarm/skills/polymarket-strategy.json` (skill plugin for Polymarket context). Acceptance: skill appears in `/api/skills`.
- [ ] **Phase 4** — crew-main: In `~/.crewswarm/crewswarm.json` set crew-mega `fallbackModel` to `deepseek/deepseek-reasoner`. Acceptance: fallback used when primary fails.
- [ ] **Phase 5** — crew-main: Add crew-mega / Polymarket strategy tips entry to `memory/brain.md`. Acceptance: entry present and loaded in prompts.

*(User told crew-lead how to make mega 10x better; this is the implementation checklist.)*

---

## Ops / Telemetry

- [ ] Add field matrix to docs/OPS-TELEMETRY-SCHEMA.md (all fields, type, which event type)
- [ ] Document heartbeat thresholds (e.g. offline after 90s without agent.presence) and task failure windows in schema doc
- [ ] Add event lifecycle guidance (versioning, unknown fields, retry/backoff when RT bridge can't publish)
- [ ] Define sample telemetry bundle (multiple event types in chronological order) for QA/UI replay
- [ ] Add validation guidelines (JSON Schema or tooling) and scripts/check-dashboard.mjs update for payload validation

---

## Backlog

(Add items here or under new sections.)
