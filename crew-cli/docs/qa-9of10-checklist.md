# 9/10 QA Checklist

Date: 2026-02-28

This checklist defines the minimum acceptance gate to claim "9/10" production readiness.

## 1. Baseline quality gates

- [x] `npm run build` (via `qa:full`) ✓ 2026-02-28
- [x] `npm run check` ✓ 2026-02-28
- [x] `npm test` ✓ 2026-02-28
- [x] `npm run qa:full` ✓ 2026-02-28

## 2. Dispatch and gateway reliability

- [x] `done + exitCode != 0` is treated as failure in router dispatch path. ✓ 2026-02-28
- [x] `done + success:false` is treated as failure in router dispatch path. ✓ 2026-02-28
- [x] direct/bypass empty output is treated as failure. ✓ 2026-02-28
- [x] rate-limit errors (`429`, `rate limit`) include user-facing retry hint. ✓ 2026-02-28

## 3. Real-call E2E coverage (non-mock)

- [x] Run `npm run qa:gateway-contract` against a live gateway. ✓ 2026-02-28
- [x] Run `npm run qa:engine-matrix` for configured engines. ✓ 2026-02-28
- [x] Run `npm run qa:pm-loop` once with a real dispatch path. ✓ 2026-02-28
- [x] Verify any `SKIP_RATE_LIMIT` result is not counted as failure. ✓ 2026-02-28
- [x] Verify all non-rate-limit failures fail the run. ✓ 2026-02-28

## 4. CI/automation gates

- [x] `crew review --strict` used in CI as a required check. ✓ 2026-02-28
- [x] Headless run artifact persisted with `--out` and uploaded in CI artifacts. ✓ 2026-02-28
- [ ] MCP config health check run with `crew mcp doctor`.

## 5. Soak and stability

- [ ] Run at least 30-minute headless session (continuous tasks).
- [ ] Confirm no runaway memory growth or repeated dispatch loops.
- [ ] Confirm pause/resume state survives process restart.

## 6. Release sign-off

- [x] `ROADMAP.md` reflects current completion status. ✓ 2026-02-28
- [x] `progress.md` includes latest QA evidence. ✓ 2026-02-28
- [ ] README/docs mention known limits and fallback behavior.

## Current Evidence (2026-02-28)

- `npm test` passed with **54/54** tests.
- `npm run qa:full` passed (build + coverage + inventory + smoke).
- Live gateway run provided by user:
  - `QA_REQUIRE_GATEWAY=true QA_GATEWAY=http://127.0.0.1:5010 npm run qa:e2e`
  - `[gateway-contract] PASS taskId=7f965d5f-001a-43d9-8a18-f89cd2551ee7`
  - `[engine-matrix] PASS cursor|claude-cli|codex-cli|gemini-cli (pass=4 skip=0 fail=0)`
  - `[pm-loop-e2e] PASS pm->coder->preview flow`
- Note: engine matrix now includes a new provenance negative-control check; run live `qa:e2e` once more to certify this updated guardrail.
