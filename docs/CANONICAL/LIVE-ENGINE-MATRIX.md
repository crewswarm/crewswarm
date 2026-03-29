# Live Engine Matrix

Use this when you want to verify real installed CLIs, real provider keys, and real fallback behavior on a machine that has the full stack available.

## Snapshot current assignments

```bash
node scripts/live-engine-matrix.mjs
```

This prints the configured route and model for each agent from `~/.crewswarm/crewswarm.json`.

## What this proves

- Which engine each agent is configured to use
- Which per-engine model override is configured
- Which fallback model is configured

## What it does not prove by itself

- That the external CLI binary is installed and authenticated
- That the provider account has credits
- That runtime fallback actually executed successfully

## Live verification workflow

For each engine you care about:

1. Assign a test agent to that engine in the dashboard.
2. Dispatch a small file-writing task.
3. Confirm the task completes.
4. Confirm the observed runtime/model in logs, UI, or task output.
5. If testing fallback, deliberately make the first route unavailable and confirm the next route is used.

## Recommended routes to verify before a public launch

- `claude-code`
- `codex`
- `cursor`
- `crew-cli`
- `gemini-cli`
- `opencode`

## Important note

This is a live environment check, not hermetic CI coverage. Treat it as release verification, not as a substitute for the automated tests in `test/` and `tests/e2e/`.
