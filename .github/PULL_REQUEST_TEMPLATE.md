## What

<!-- 1-3 sentences: what does this PR change? -->

## Why

<!-- Why is this change needed? Link to issue if applicable. Closes #___  -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (requires version bump + CHANGELOG entry)
- [ ] Refactor / cleanup (no behavior change)
- [ ] Docs / tests only

## How

<!-- High-level approach. Notable decisions or tradeoffs. -->

## Test plan

- [ ] `npm test` passes (`node --test test/unit/*.test.mjs test/integration/*.test.mjs`)
- [ ] New behavior covered by a test (or explain why not)
- [ ] Manual test steps (if UI change): describe what you clicked and what you saw
- [ ] E2E tested against live services if touching dispatch/pipeline/bridge code

## Checklist

- [ ] `node scripts/check-dashboard.mjs --source-only` passes (if dashboard was touched)
- [ ] No API keys, tokens, or secrets in the diff
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Docs updated if behaviour changed (AGENTS.md, README, relevant `docs/` file)

## Screenshots / recordings

<!-- For UI changes: before/after screenshots or a short screen recording -->
