# CrewSwarm — Ops / Core Roadmap

> Ops and core product work (telemetry, dashboard, validation). Website feature work lives in `website/ROADMAP.md`.

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
- [ ] **Phase 2** — crew-coder: Create `~/.crewswarm/skills/polymarket-strategy.json` (skill plugin for Polymarket context). Acceptance: skill appears in `/api/skills`.
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
