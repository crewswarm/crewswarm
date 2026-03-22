# Testing

## Principle

If a rule matters to correctness, it should have code-level verification.

Docs explain behavior. Tests enforce it.

## Current testing layers

- unit tests for intent/routing logic
- smoke scripts for end-to-end behavior
- Playwright browser automation for Vibe/Studio UI flows
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
# Unit tests (no services required)
node --test test/unit/mention-routing-intent.test.mjs
node --test test/unit/thread-binding.test.mjs

# Static smoke (syntax, build, health — no services)
npm run smoke:static
# or: bash scripts/smoke.sh

# Live smoke (requires stack running: crew-lead, agents)
npm run smoke
# or: node scripts/smoke-dispatch.mjs

# Node E2E (requires crew-lead on 5010)
node --test test/e2e/*.test.mjs
```

## Live smoke (npm run smoke)

When the full stack is running (`npm run restart-all`), `npm run smoke` runs `scripts/smoke-dispatch.mjs`:

- Dispatches to crew-coder (writes a test file)
- Dispatches to crew-main (simple reply)
- Verifies both complete successfully

Used by CI integration job on push. Requires `GROQ_API_KEY` and `CREWSWARM_RT_TOKEN` in secrets.

## Browser automation (Playwright)

Playwright is configured for `tests/e2e/*.spec.js` but no specs exist yet. To add:

```bash
mkdir -p tests/e2e
# Add *.spec.js files, then:
npx playwright test tests/e2e
npx playwright install   # if browsers not installed
```

Use browser automation for UI state that shell smoke cannot validate: project creation, editor/chat controls, persisted chat history after reload.

Legacy root verification scripts were archived under `docs/archive/legacy-tests/root/`. Keep new tests in `test/` (unit/integration/e2e) or `tests/e2e/` (Playwright).

## Rule for contributors

Do not rely on prompt edits or doc edits alone for critical routing behavior. Add or update a regression test.
