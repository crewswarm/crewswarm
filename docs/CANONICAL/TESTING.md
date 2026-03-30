# Testing

## Principle

If a rule matters to correctness, it should have code-level verification.

Docs explain behavior. Tests enforce it.

## Current testing layers

- unit tests for intent/routing logic
- smoke scripts for end-to-end behavior
- Playwright browser automation for Dashboard and Vibe UI flows
- runtime/module load checks
- targeted regression tests for production failures

## Required regressions

Routing changes should keep tests for:

- direct vs dispatch classification
- multi-mention behavior
- thread continuity
- runtime/source labeling
- mention-triggered follow-up behavior

## Useful commands

```bash
# Full Node test aggregate
npm run test:all

# Repo-wide coverage summary
npm run test:coverage

# Root runtime coverage only
npm run test:coverage:root

# Unit tests (no services required)
node --test test/unit/mention-routing-intent.test.mjs
node --test test/unit/thread-binding.test.mjs

# Integration tests (mostly hermetic)
node --test test/integration/*.test.mjs

# Static smoke (syntax, build, health — no services)
npm run smoke:static
# or: bash scripts/smoke.sh

# Live smoke (requires stack running: crew-lead, agents)
npm run smoke
# or: node scripts/smoke-dispatch.mjs

# Node E2E (requires crew-lead on 5010)
node --test test/e2e/*.test.mjs

# Browser E2E (requires dashboard + vibe + crew-lead)
node node_modules/playwright/cli.js test tests/e2e --reporter=list

# Live external verification
node scripts/live-provider-failover-matrix.mjs
node scripts/live-bridge-matrix.mjs
node scripts/live-crewchat-check.mjs
```

## Live smoke (npm run smoke)

When the full stack is running (`npm run restart-all`), `npm run smoke` runs `scripts/smoke-dispatch.mjs`:

- Dispatches to crew-coder (writes a test file)
- Dispatches to crew-main (simple reply)
- Verifies both complete successfully

Used by CI integration job on push. Requires `GROQ_API_KEY` and `CREWSWARM_RT_TOKEN` in secrets.

## Browser automation (Playwright)

Playwright is configured for `tests/e2e/*.spec.js`.

Current browser coverage includes:

- Dashboard Services tab rendering and status badges
- Dashboard Engines tab rendering and engine toggle POST wiring
- Dashboard Workflows tab list/editor flows, `New`, `Add Stage`, and `Run Now`
- Dashboard chat history/send wiring
- Dashboard Memory stats and search rendering
- Dashboard Benchmarks leaderboard rendering
- Dashboard Agents tab per-engine assignment wiring
- Dashboard Providers / Settings persistence wiring
- Vibe project selector readiness and file tree loading
- Vibe Monaco file open and autosave persistence via API
- Vibe chat send/render, project-switch chat isolation, and chat mode switching
- Vibe deterministic project routing and agent-mode chat wiring

Main specs:

- `tests/e2e/dashboard-tabs.spec.js`
- `tests/e2e/dashboard-core-surfaces.spec.js`
- `tests/e2e/agents-tab.spec.js`
- `tests/e2e/providers-settings.spec.js`
- `tests/e2e/vibe-editor.spec.js`
- `tests/e2e/vibe-chat-routing.spec.js`

Run:

```bash
node node_modules/playwright/cli.js test tests/e2e --reporter=list
npx playwright install   # if browsers not installed
```

Use browser automation for UI state that shell smoke cannot validate: project creation, editor/chat controls, persisted chat history after reload.

Legacy root verification scripts were archived under `docs/archive/legacy-tests/root/`. Keep new tests in `test/` (unit/integration/e2e) or `tests/e2e/` (Playwright).

## Coverage notes

- Root repo coverage is reported by `npm run test:coverage:root` using Node's built-in test coverage.
- `crew-cli` coverage is reported by `cd crew-cli && npm run test:coverage`.
- `npm run test:coverage` at repo root runs both and writes a combined markdown report to `coverage/coverage-report.md`.
- The current coverage report is strongest for hermetic unit/integration surfaces. Live services, messaging bridges, and browser flows still rely partly on smoke and E2E checks rather than a single unified percentage.
- `crewchat` runtime decisions, bridge contracts, startup guard behavior, and restart/health script failure paths now have dedicated automated tests in `test/unit/`.
- Provider failover classification now has a bounded integration matrix in `test/integration/llm-failover-matrix.test.mjs`.
- External/provider/native surfaces now also have explicit live harnesses documented in `docs/CANONICAL/LIVE-VERIFICATION.md`.
- See `docs/CANONICAL/COVERAGE-MATRIX.md` for a feature-by-feature status view instead of treating one percentage as universal truth.

## Rule for contributors

Do not rely on prompt edits or doc edits alone for critical routing behavior. Add or update a regression test.
