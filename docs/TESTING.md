# Testing Guide

CrewSwarm has **4,355 test cases** across unit, integration, e2e, and Playwright suites — all passing (1 intentional skip: native macOS folder picker).

## Quick Reference

```bash
npm test                     # Unit + standalone + crew-cli (offline, ~2min)
npm run test:unit            # Root unit tests only (~133 files, 3,591 tests)
npm run test:integration     # Integration tests (needs :4319 + :5010)
npm run test:e2e             # E2E live tests (needs server + engines)
npm run test:all             # All root suites combined (sequential: unit → integration → e2e → crew-cli)
npm --prefix crew-cli test   # Crew-CLI unit tests only (~82 files, 765 tests)
npm run test:report          # Generate summary from last run
npm run test:stale           # Show tests affected by recent file changes
```

## Test Reporting

All tests produce structured JSONL output via the custom reporter (`scripts/test-reporter.mjs`):

- **Per-run artifact dirs:** `test-results/runs/<runId>/` with `run.json`, `summary.json`, `summary.md`
- **Run metadata:** git commit, branch, dirty state, Node version, platform, hostname
- **File fingerprints:** SHA256 + git blob hash per test file
- **Start + finish phases:** per test, not just results
- **Failure enrichment:** timeout detection, error name/code/stack, artifact paths
- **Evidence entries:** engine metadata, HTTP traces, file verifications via `test/helpers/test-log.mjs`
- **Blast radius tracking:** `scripts/test-blast-radius.mjs` detects which tests are stale based on dependency changes

```bash
npm run test:report   # Human-readable summary of last run
npm run test:stale    # Which tests need re-running after code changes
```

## Test Suites

### Root Unit Tests (`test/unit/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test | 133 | ~3,591 | No |

The main test suite. Runs offline — no server, no network. Covers:
- Agent registry, dispatch parsing, classifiers, daemon, permissions, validation, tool instructions
- Wave dispatcher, pipeline logic, pipeline manager
- **Quality gates:** question detection, planning/build agent output validation, QA FAIL auto-fix with crew-fixer wave insertion, retry with feedback, halt/advance-on-fail, cursor-wave combined output parsing
- Engine routing, selection, fallback, OpenCode engine, LLM-direct engine
- PM loop logic, synthesis, judge decisions, crew-judge with LLM integration
- RT envelope, DLQ, retry management
- Session management, shared memory, memory shared-adapter
- Dashboard validation schemas
- Background consciousness, autonomous mentions
- Policy manager, spending caps
- Chat history, participants, project messages, RAG, unified wrapper
- Crew-lead prompts, tools, background loop, interval managers
- Contacts identity linker, bridges integration
- CLI process tracker, domain planning, preferences extractor
- Integrations code search, Gemini CLI passthrough noise filtering
- Root orchestrators (gateway-bridge, telegram/whatsapp bridges, unified/phased/natural-PM orchestrators, continuous-build)
- Tools executor (file I/O, command execution, permission gates)

### Crew-CLI Unit Tests (`crew-cli/tests/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test + tsx | 82 | ~765 | No |

- `crew-cli/tests/unit/*.test.js` — sandbox, orchestrator, worker pool, context augmentation, strategies, risk scoring, prompt registry, model policies, etc.
- `crew-cli/tests/*.test.js` — pipeline, router, REPL, LSP, planner, interface server

### Integration Tests (`test/integration/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test | 17 | ~352 | Yes (:4319 + :5010) |

Tests that hit the live dashboard and crew-lead APIs:
- **dashboard-api.test.mjs** — Zod schema validation for core endpoints (build, enhance-prompt, pm-loop, services, skills)
- **dashboard-api-full.test.mjs** — Smoke tests for ALL 147 dashboard endpoints (settings, sessions, providers, config, chat, memory, DLQ, contacts, bridges, workflows, etc.)
- **workflow-crud.test.mjs** — Full workflow CRUD lifecycle
- **http-server.test.mjs** — HTTP server endpoint coverage
- **pipeline-manager.test.mjs** — Pipeline dispatch and state management
- **chat-history.test.mjs** — Chat history persistence
- **spending.test.mjs** — Spending tracking
- **rt-bus-integration.test.mjs** — Real WebSocket RT bus: handshake, broadcast/targeted routing, ACK round-trip, multi-agent connect/disconnect, full dispatch→result flow
- **crash-recovery.test.mjs** — Pipeline crash recovery: save/resume at correct wave, retry counter preservation, stale cleanup (>2hr), corrupted JSON handling, multi-pipeline resume
- **spending-cap-enforcement.test.mjs** — Full spending cap flow: global token/cost limits, per-agent caps (stop/pause/notify), recordTokenUsage→checkSpendingCap integration, daily reset
- And more

### E2E Tests (`test/e2e/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test + Puppeteer | 15 | ~132 | Yes (:4319 + :5010 + engines) |

Live end-to-end tests with real engines and browser automation:

**Engine Passthrough (chat-passthrough-engines.test.mjs)**
- Each CLI engine (Claude Code, Cursor, Gemini CLI, OpenCode) responds via passthrough API
- Session resume: Claude Code recalls context from prior messages
- Expected timing documented per engine (5-60s depending on engine)

**Multi-Engine File Creation (multi-engine-dispatch.test.mjs)**
- Each engine writes an HTML file to a temp directory
- File existence and content verified on disk
- Mixed-engine parallel wave (2 engines simultaneously)

**Build Planner (dashboard-build-planner-live.test.mjs)**
- All 6 engines produce structured build briefs via `/api/enhance-prompt`
- Runs sequentially to avoid dashboard overload

**Dashboard Tab Rendering (dashboard-tabs.test.mjs)**
- All 24 dashboard tabs load without errors
- 5 settings subtabs render
- Cross-tab navigation works
- Rapid tab switching stress test

**Dashboard Chat (dashboard-chat-tabs.test.mjs)**
- Chat click-send and enter-send
- Swarm chat click-send and enter-send

**Lifecycle Flows (dashboard-lifecycle.test.mjs)**
- Settings toggle (read, change, verify, restore)
- Agent config mutations
- Project CRUD (create, update, delete, verify)
- DLQ read and replay
- Memory search and compact
- File browser (list + content)
- Services status verification
- RT message bus visibility
- SSE event streaming
- Engine runtime status
- Token usage tracking

**Pipeline & Waves (pipeline-waves-live.test.mjs)**
- 2-agent wave runs in parallel
- Waves execute in sequence (wave 1 before wave 2)
- Pipeline status tracking

**PM Loop (pm-loop-live.test.mjs)**
- Project creation with ROADMAP.md
- Dry-run start, status check, stop
- PM options (coderAgent, taskTimeoutMin) passed correctly
- Log file verification

**Live Dispatch (live-dispatch.test.mjs)**
- Health check, chat reply, agent dispatch
- History persistence, agent list, pipeline execution

**Bridge Roundtrips:**
- **telegram-roundtrip.test.mjs** — Bot info, message delivery, log verification, crew-lead forwarding
- **whatsapp-roundtrip.test.mjs** — Health, phone number match, send/receive, auth persistence, log verification

## Running E2E Tests

E2E tests run **one file at a time** via targeted npm scripts to avoid resource contention:

```bash
# Run all e2e sequentially via grouped scripts (recommended)
npm run test:e2e

# Individual groups:
npm run test:e2e:passthrough   # Engine passthrough tests
npm run test:e2e:dashboard     # Dashboard lifecycle, tabs, chat
npm run test:e2e:dispatch      # Live dispatch, surfaces, multi-engine
npm run test:e2e:pipeline      # Pipeline waves, PM loop
npm run test:e2e:build         # Build planner
npm run test:e2e:bridge        # Telegram + WhatsApp roundtrips

# Stress tests (excluded from default test:e2e):
npm run test:e2e:stress        # Load stress + cron workflow
```

Running all e2e files simultaneously will cause timeouts due to shared service resources.

### Playwright Browser Tests (`tests/e2e/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| Playwright | 17 | ~222 | Yes (:4319 + Chrome) |

Real browser interaction tests — clicks buttons, fills inputs, verifies API payloads and DOM state changes. Every spec captures `console.error` and `pageerror` events via shared `helpers.mjs` and fails if unexpected errors occur.

**All 19 dashboard tabs covered:**

| Spec | Tab(s) | Key interactions tested |
|------|--------|----------------------|
| `agents-tab.spec.js` | Agents | Engine route buttons, model save |
| `contacts-tab.spec.js` | Contacts | Add/edit/delete contacts, search, platform badges |
| `models-tab.spec.js` | Models | OAuth status, model dropdowns, test connection, provider keys |
| `skills-tab.spec.js` | Skills | Install/edit/delete skills, import URL |
| `swarm-tab.spec.js` | Swarm, RT Messages, DLQ | Session list, engine selector, phase badges, DLQ replay |
| `swarm-chat-tab.spec.js` | Swarm Chat | Send message, @mention autocomplete, autonomy toggle, project switch |
| `waves-tab.spec.js` | Waves | Wave cards, agent assignment, add/remove agents, save/reset config |
| `projects-tab.spec.js` | Projects | Create/edit/delete, PM loop start/stop, roadmap progress |
| `spending-tab.spec.js` | Spending | Cost breakdown, days selector, token cap, reset |
| `usage-tab.spec.js` | Usage | Token stats, by-model breakdown, tool matrix, agent restart |
| `comms-tab.spec.js` | Comms | Telegram/WhatsApp config, bridge start/stop, message feeds |
| `dashboard-tabs.spec.js` | Services, Engines, Workflows | Service cards, engine toggles, workflow CRUD |
| `dashboard-additional-tabs.spec.js` | Build, Memory, Engines, Settings, Prompts | PM Loop buttons, memory search, spending widget, prompt edit |
| `dashboard-core-surfaces.spec.js` | Chat, Memory, Benchmarks | Chat send, memory search results, leaderboard |
| `providers-settings.spec.js` | Settings | Provider key save, RT token, OpenCode settings |

**Vibe editor/chat covered:**

| Spec | Key interactions tested |
|------|----------------------|
| `vibe-editor.spec.js` | File tree click, Monaco editor load, autosave, chat send, project switch, mode selector |
| `vibe-chat-routing.spec.js` | Project selector, agent/CLI chat modes |

**Console error capture:** Every spec imports `setupConsoleErrorCapture(page)` in `beforeEach` and `expectNoConsoleErrors()` in `afterEach`. Ignored patterns: favicon 404s, EventSource reconnects, ResizeObserver.

```bash
# Run all Playwright tests
npx playwright test

# Run a specific spec
npx playwright test tests/e2e/contacts-tab.spec.js

# Run with headed browser (debugging)
npx playwright test --headed
```

## Dashboard API Coverage

All 147 dashboard endpoints are tested:
- 27 endpoints with deep validation tests (schema checks, input rejection)
- 120+ endpoints with smoke tests (route exists, valid response shape)
- 12 lifecycle flows (settings toggle, project CRUD, memory, DLQ, SSE, etc.)

## Engine Routing

Tests verify the engine selection logic documented in `docs/ORCHESTRATION-PROTOCOL.md`:
- Coding keywords → CLI engine (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, crew-cli)
- Non-coding tasks → direct-llm (API call with @@tool markers)
- Per-agent engine config from `crewswarm.json` `use*` flags

## Test Counts Summary

| Suite | Files | Cases | Offline |
|-------|-------|-------|---------|
| Root unit | 133 | 2,886 | Yes |
| Crew-CLI unit | 85 | 765 | Yes |
| Integration | 17 | 355 | No |
| E2E (node:test) | 12 | 120 | No |
| Playwright | 18 | 229 | No |
| **Total** | **265** | **4,355** | |

## Where to Find Results

### Log files

| File | Contents |
|------|----------|
| `test-results/test-log.jsonl` | Append-only JSONL log of every test result across all runs |
| `test-results/.last-run.json` | Summary of the most recent run (pass/fail counts, failed test list) |
| `test-results/.current-run.json` | Metadata for the currently running test |
| `test-results/runs/<runId>/run.json` | Full run metadata (git commit, branch, node version, platform) |
| `test-results/runs/<runId>/summary.json` | Machine-readable run summary |
| `test-results/runs/<runId>/summary.md` | Human-readable run summary |
| `test-results/runs/<runId>/<testId>/` | Per-test artifact directory with evidence files |
| `crew-cli/test-results/test-log.jsonl` | Crew-CLI test results (separate log) |

### Reading results

```bash
# Quick summary of last run
npm run test:report

# Show which tests are stale (affected by code changes since last run)
npm run test:stale

# View the raw JSONL log
cat test-results/test-log.jsonl | python3 -m json.tool

# Count pass/fail from log
grep '"status":"fail"' test-results/test-log.jsonl | wc -l

# Show all failures with error messages
grep '"fail"' test-results/test-log.jsonl | \
  python3 -c "import sys,json; [print(f'{json.loads(l)[\"name\"]}: {json.loads(l).get(\"error\",\"\")[:100]}') for l in sys.stdin if json.loads(l).get('status')=='fail']"

# View latest run summary
cat test-results/runs/$(ls -t test-results/runs/ | head -1)/summary.md
```

### JSONL entry format

Each test result in the JSONL log contains:

```json
{
  "runId": "2026-03-30T16-15-22-855Z",
  "timestamp": "2026-03-30T16:16:47.645Z",
  "entry_type": "result",
  "phase": "finish",
  "status": "pass",
  "name": "Claude Code responds via passthrough",
  "file": "/path/to/test/e2e/chat-passthrough-engines.test.mjs",
  "file_fingerprint": { "sha256": "...", "git_blob": "..." },
  "duration_ms": 7329.92,
  "nesting": 1,
  "line": 139,
  "column": 5
}
```

Failed entries also include `error`, `error_name`, `error_code`, `error_stack`, and `timeout_detected`.

Evidence entries (engine diagnostics) have `entry_type: "evidence"` with category-specific data like engine timing, HTTP traces, and file verifications.

## Troubleshooting

### E2E tests timeout

Run e2e tests **one file at a time**, not all at once. Concurrent engine calls overload services:

```bash
# BAD — all at once, will timeout
npm run test:e2e

# GOOD — sequential
for f in test/e2e/*.test.mjs; do
  node --test --test-reporter=./scripts/test-reporter.mjs "$f"
done
```

### ECONNRESET errors

Node 25's HTTP connection pooling can reuse closed sockets. The test helpers use `connection: close` and `agent: false` to prevent this. If you see ECONNRESET, check that the test file uses `httpRequest` from `test/helpers/http.mjs` (not `fetch`).

### Dashboard crashes during tests

The dashboard now survives engine passthrough errors without crashing (`process.exit(1)` replaced with resilient error handling). If you see cascading failures (first test passes, rest get "connection refused"), check `/tmp/crewswarm-dashboard.log` for crash logs and restart with `bash scripts/restart-service.sh dashboard`.

### Engine-specific failures

| Engine | Common issue | Fix |
|--------|-------------|-----|
| Codex | Rate limited | Wait for reset (check error message for time) |
| Gemini CLI | Slow (30-120s) | Normal — scans repo via `--include-directories` |
| OpenCode | Empty response | Check `~/.opencode/config.json` has a valid model |
| Cursor CLI | Session conflicts | Clear with `/api/engine-passthrough/clear-session` |

### RT bus "agent unreachable"

If dispatch returns 503 "RT bus not connected", crew-lead's WebSocket reconnected and the publish function is temporarily null. The reconnect delay is 1s with exponential backoff. Wait and retry. Check `grep 'RT disconnected' /tmp/crew-lead.log`.

## CI

GitHub Actions runs:
- **ci.yml** (on PRs) — syntax checks, dashboard validation, unit tests (`npm test`)
- **smoke.yml** (on push) — static checks + integration tests

## Adding Tests

- **Unit tests:** Add to `test/unit/` using `node:test` + `node:assert/strict`
- **Integration tests:** Add to `test/integration/` — guard with `checkServiceUp`
- **E2E tests:** Add to `test/e2e/` — use Puppeteer for browser, `httpRequest` for API
- **Crew-CLI tests:** Add to `crew-cli/tests/unit/` using `node:test`
- **Evidence logging:** Use `logTestEvidence` from `test/helpers/test-log.mjs` for diagnostic data
- **HTTP tracing:** Pass `trace` option to `httpRequest` for automatic request/response logging
