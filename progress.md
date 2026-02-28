# CrewSwarm — Go-Public Progress

Last updated: 2026-02-28 (session 4)

---

## Phase 1 — Reliability gates ✅ COMPLETE

| Task | Status |
|------|--------|
| Smoke-dispatch (coder + main) | ✅ Done |
| E2E build smoke | ✅ Done |
| npm scripts: `smoke:dispatch`, `smoke:e2e`, `smoke` | ✅ Done |
| GitHub Actions CI (`smoke.yml`) — fail hard on timeout | ✅ Done |
| `openswitchctl doctor` with PASS/FAIL output | ✅ Done |
| Bridge cap (hard max process count) | ✅ Done — `CREWSWARM_MAX_BRIDGES` in `scripts/start-crew.mjs` (default 20) |
| Queue limit + bounded retries + jitter | ✅ Done — `CREWSWARM_DISPATCH_QUEUE_LIMIT` (default 50); jittered wave retry 500–1500ms |
| Duplicate spawn guard per agent | ✅ Done (`start-crew.mjs`) |

---

## Phase 2 — Operability and correctness ✅ COMPLETE

| Task | Status |
|------|--------|
| Canonical JSON dispatch format | ✅ Done — documented in `docs/ARCHITECTURE.md` (dispatch + result envelope schemas) |
| Result envelope shape (`status`, `taskId`, `result`, `error`, `filesTouched`) | ✅ Done — schema in `docs/ARCHITECTURE.md` |
| Coordinator-only dispatch tests | ✅ Done — 33 tests in `test/unit/coordinator-dispatch.test.mjs` (all pass) |
| Correlation ID PM → dispatch → done/issues → synthesis | ✅ Done — `correlationId` in RT payload, pendingDispatches, SSE, lifecycle events |
| `openswitchctl health` snapshot command | ✅ Done — RT bus, bridges, crew-lead pipelines/timeouts, dashboard |
| Structured logs (human + machine parseable) | ✅ Done — `lib/runtime/logger.mjs`; `LOG_FORMAT=json` for NDJSON |

---

## Phase 3 — Public launch confidence ✅ COMPLETE

### 6) Fresh-machine automation

| Task | Status | Notes |
|------|--------|-------|
| Scripted clean-user install test | ✅ Done | `scripts/fresh-machine-smoke.sh` — 9-step test, exits non-zero on failure |
| "clone → install → first build" checklist | ✅ Done | `docs/FRESH-MACHINE-VERIFY.md` — full transcript + expected output |
| Failure recovery steps in docs | ✅ Done | `docs/FRESH-MACHINE-VERIFY.md` failure table + `docs/TROUBLESHOOTING.md` |

### 7) Public-repo hygiene

| Task | Status | Notes |
|------|--------|-------|
| `.env.example` with all env vars | ✅ Done | 50-line reference covering all engines, ports, PM loop, messaging |
| `.gitignore` covers logs/state/runtime artifacts | ✅ Done | `*.log`, `*.pid`, `logs/`, `orchestrator-logs/`, runtime memory state |
| Top-5 troubleshooting section | ✅ Done | Quick-reference table with anchors + `openswitchctl health` tip |
| Private docs out of tracking | ✅ Done | `ROADMAP-PRIVATE.md`, session summaries, scratch files gitignored |

---

## Remaining (needs live system / human action)

- [ ] Add GitHub repo secrets: `CREWSWARM_RT_TOKEN` + `GROQ_API_KEY` → makes CI smoke green
- [ ] 24-hour soak test — no runaway processes
- [ ] Fresh-machine live CI run (script exists; needs secrets)
- [ ] Demo flow (`crew-lead → crew-coder`, `crew-lead → crew-main`) 3/3 attempts

---

## Phase 4 — Go public (next)

| Task | Status |
|------|--------|
| Bump version `0.1.0-alpha` → `0.9.0-beta` | ⬜ Pending |
| Write CHANGELOG entry for `[0.9.0-beta]` | ⬜ Pending |
| Verify `package.json` public fields + `npm pack --dry-run` | ⬜ Pending |
| Tag + push: `git tag v0.9.0-beta` | ⬜ Pending |
| Create GitHub release with CHANGELOG body | ⬜ Pending |
| README: quick-start section, screenshot, badges | ⬜ Pending |
| GitHub repo: description, website URL, topics | ⬜ Pending |
| Announcement post (HN / X / LinkedIn) | ⬜ Pending |
