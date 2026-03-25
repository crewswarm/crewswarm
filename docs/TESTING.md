# Testing Guide

CrewSwarm has ~1,100 test cases across multiple suites and runners.

## Quick Reference

```bash
npm test                     # Unit + standalone + crew-cli (offline, ~15s)
npm run test:integration     # Integration tests (needs server on :4319/:5010)
npm run test:e2e             # E2E browser tests (needs server + Playwright)
npm run test:all             # All root suites combined (needs server)
npm --prefix crew-cli test   # Crew-CLI unit tests only
```

## Test Suites

### Root Unit Tests (`test/unit/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test | 40 | ~648 | No |

The main test suite. Runs offline — no server, no network. Covers agent registry, dispatch parsing, classifiers, wave dispatcher, PM loop logic, engine routing, and more.

```bash
npm run test:unit
```

### Root Standalone Tests (`test/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test | 3 | ~6 | No |

- `mention-participants.test.mjs` — chat mention routing
- `project-messages-chat-protocol.test.mjs` — project message threading
- `performance-tooling.test.mjs` — performance benchmark harness (requires `scripts/bench/performance_optimization.py`)

### Integration Tests (`test/integration/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test | 11 | ~200+ | Yes (:4319 + :5010) |

Tests that hit the live dashboard and crew-lead APIs. Covers:
- Dashboard API validation (build, PM loop, pick-folder)
- Workflow CRUD (create, list, update, delete)
- Pipeline management
- Chat history persistence
- Spending tracking
- Scheduled workflows
- Browser E2E (Playwright-based, in integration)
- LLM direct calls (needs API keys)

```bash
npm run test:integration
# or with env override:
DASHBOARD_BASE=http://localhost:4319 npm run test:integration
```

**Required env:** `PM_LOOP_TEST_MODE=1` (set automatically by the script).

### E2E Tests (`test/e2e/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test + Playwright | 7 | ~50+ | Yes (:4319 + :5010) |

Live end-to-end tests with real browser automation:
- `dashboard-chat-tabs.test.mjs` — chat tab switching
- `live-dispatch.test.mjs` — real agent dispatch
- `pipeline-waves-live.test.mjs` — pipeline wave execution
- `pm-loop-live.test.mjs` — PM loop full cycle
- `surfaces-dispatch-live.test.mjs` — dispatch from dashboard UI
- `telegram-roundtrip.test.mjs` — Telegram bridge roundtrip
- `whatsapp-roundtrip.test.mjs` — WhatsApp bridge roundtrip

```bash
npm run test:e2e
```

### Playwright Specs (`tests/e2e/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| Playwright | 2 | ~20+ | Yes (:4319) |

Separate Playwright test directory:
- `dashboard-tabs.spec.js` — dashboard tab navigation
- `vibe-editor.spec.js` — Vibe editor interactions

```bash
npx playwright test tests/e2e/
```

### Crew-CLI Unit Tests (`crew-cli/tests/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| node:test + tsx | 19 | ~163 | No |

Two tiers:
- `crew-cli/tests/*.test.js` — top-level (pipeline, router, REPL, LSP, planner, interface server)
- `crew-cli/tests/unit/*.test.js` — lower-level (JSON schemas, structured JSON, logger, math, Gemini adapter, task envelope)

```bash
npm --prefix crew-cli test                # unit tests only
npm --prefix crew-cli run test:coverage   # unit tests + coverage report
```

### Vibe App Tests (`apps/vibe/test/`)

| Runner | Files | Cases | Requires server |
|--------|-------|-------|-----------------|
| Custom | 4 | ~30+ | Yes (Vibe on :3000) |

Custom test harnesses for the Vibe editor:
- `accessibility-tests.js` — a11y assertions
- `browser-performance-audit.mjs` — Lighthouse-style performance
- `performance-tests.js` — runtime performance
- `security-tests.js` — security checks

## CI

GitHub Actions runs two workflows:

- **ci.yml** (on PRs) — syntax checks, dashboard validation, unit tests (`npm test`)
- **smoke.yml** (on push) — static checks + integration tests with `GROQ_API_KEY` and `CREWSWARM_RT_TOKEN` from GitHub Secrets

## Test Counts Summary

| Suite | Files | Est. Cases | Offline |
|-------|-------|------------|---------|
| Root unit | 40 | 648 | Yes |
| Root standalone | 3 | 6 | Yes |
| Integration | 11 | 200+ | No |
| E2E (node:test) | 7 | 50+ | No |
| Playwright specs | 2 | 20+ | No |
| Crew-CLI | 19 | 163 | Yes |
| Vibe app | 4 | 30+ | No |
| **Total** | **86** | **~1,100+** | |

## Adding Tests

- **Unit tests:** Add to `test/unit/` using `node:test` + `node:assert/strict`
- **Integration tests:** Add to `test/integration/` — guard with server connectivity check
- **E2E tests:** Add to `test/e2e/` — use Playwright for browser automation
- **Crew-CLI tests:** Add to `crew-cli/tests/unit/` using `node:test`
