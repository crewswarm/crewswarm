# Testing

## Principle

If a rule matters to correctness, it should have code-level verification.

Docs explain behavior. Tests enforce it.

## Current testing layers

- unit tests for intent/routing logic
- smoke scripts for end-to-end behavior
- Playwright browser automation for Dashboard and Vibe/Studio UI flows
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
- Dashboard chat dispatch through crew-lead
- Vibe project selector readiness and file tree loading
- Vibe Monaco file open and autosave persistence via API
- Vibe chat send/render, project-switch chat isolation, and chat mode switching

Main specs:

- `tests/e2e/dashboard-tabs.spec.js`
- `tests/e2e/dispatch-surfaces.spec.js`
- `tests/e2e/vibe-editor.spec.js`

Run:

```bash
node node_modules/playwright/cli.js test tests/e2e --reporter=list
npx playwright install   # if browsers not installed
```

Use browser automation for UI state that shell smoke cannot validate: project creation, editor/chat controls, persisted chat history after reload.

Legacy root verification scripts were archived under `docs/archive/legacy-tests/root/`. Keep new tests in `test/` (unit/integration/e2e) or `tests/e2e/` (Playwright).

## Rule for contributors

Do not rely on prompt edits or doc edits alone for critical routing behavior. Add or update a regression test.
