# Progress Update

Date: 2026-02-28

## 9/10 Hardening Pass (in progress) — 2026-02-28

- Fixed gateway passthrough result semantics in `src/agent/router.ts`:
  - `status=done` no longer implies success.
  - If gateway result includes `exitCode != 0` (or `success:false` / `ok:false`), dispatch now throws and exits non-zero.
  - Added explicit empty-output errors for `--direct` / `--bypass` paths.
- Added regression test:
  - `tests/router.test.js` now asserts failure on `done` payload with `exitCode: 1`.
- Added additional dispatch contract tests:
  - fail on `done` payload with `success: false`
  - fail on empty `done` payload for direct passthrough
- Updated roadmap status:
  - Marked Phase 4.2 (GitHub advanced triggers) as completed where already implemented.
  - Added a dedicated "Reliability Gate to 9/10" checklist for remaining quality work.
- Verification:
  - `npm run qa:full` ✓ (54 passing tests, 0 failing)
  - `npm run check` ✓
  - `npm test` ✓ (54 passing, 0 failing)
  - Live `npm run qa:e2e` ✓ on `QA_GATEWAY=http://127.0.0.1:5010`:
    - `[gateway-contract] PASS taskId=7f965d5f-001a-43d9-8a18-f89cd2551ee7`
    - `[engine-matrix] PASS cursor|claude-cli|codex-cli|gemini-cli (pass=4 skip=0 fail=0)`
    - `[pm-loop-e2e] PASS pm->coder->preview flow`
  - Updated `docs/qa-9of10-checklist.md` and checked off completed gates

## Completed

- Added OpenCode GitHub v1 automation workflow:
  - `.github/workflows/opencode-comment.yml` (comment-triggered)
  - `.github/workflows/opencode-pr-review.yml` (automatic PR review)
  - `.github/workflows/opencode-triage.yml` (issue triage with spam filter)
  - `.github/workflows/opencode-scheduled.yml` (weekly maintenance)
- Workflow gates:
  - Runs on `/oc` or `/opencode` comment commands.
  - Restricted to `OWNER`, `MEMBER`, `COLLABORATOR`.
  - Account age check (30+ days) for issue triage spam prevention
- Added GitHub operations notes:
  - `github.md` with setup, required secrets, usage, and safety notes.
  - `docs/github-qa-checklist.md` with QA verification steps

## OpenCode Feature Comparison (2026-02-28)

### ✅ Features We Have (Complete Parity)
1. **Comment Triggers** - `/oc` and `/opencode` commands ✓
2. **PR Auto-Review** - Opens on `pull_request: [opened, synchronize]` ✓
3. **Issue Triage** - With 30-day account age spam filter ✓
4. **Scheduled Tasks** - Weekly cron + manual dispatch ✓
5. **Permission Gating** - OWNER/MEMBER/COLLABORATOR restrictions ✓
6. **Custom Prompts** - Per-workflow customization ✓
7. **Code-Line Comments** - Via `pull_request_review_comment` event ✓

### 🎯 OpenCode Features We DON'T Need
- Session sharing (`share: true`) - Not relevant for our architecture
- OpenCode GitHub App installation - We use built-in `github.token`
- Alternative token options (PAT) - Built-in token is sufficient
- Workflow dispatch for every event - Manual triggers less useful than comments

### 💡 Unique Advantages We Have
- **Multiple model support** - Can use any OpenRouter model, not just Claude
- **Integration with CrewSwarm** - Full multi-agent dispatch available
- **Local testing** - Can test workflows with crew-cli before GitHub Actions
- **Cost tracking** - Built into CrewSwarm dashboard

## Notes

- OpenCode workflow requires `ANTHROPIC_API_KEY` secret.
- Workflow uses built-in `github.token` for repo writes/comments.
- Added Node 24 test compatibility fix:
  - Replaced `chalk` dependency in `src/utils/logger.ts` with internal ANSI color helpers
  - Removes ESM import mismatch in `tests/orchestrator.test.js` and `tests/router.test.js`
- Latest verification:
  - `npm run build` ✓
  - `npm run check` ✓
  - `npm test` ✓ (34 passing, 0 failing on Node v24.10.0)

## ROI Import Pass (Copilot/OpenHands/Sourcegraph) — 2026-02-28

- Added Copilot-style commands:
  - `crew review` (git diff audit before commit)
  - `crew context` (active context window report)
  - `crew compact` (history/cost compaction + context summary write)
  - `crew mcp add|list|remove` (MCP server management UX)
- Added OpenHands-style headless execution:
  - Top-level shortcut: `crew --headless --json -t \"...\"`
  - Explicit run command: `crew headless run -t \"...\" [--json] [--always-approve]`
  - Pause/resume controls: `crew headless pause|resume|status`
- Added Sourcegraph-style context ingestion and integration:
  - `chat`/`dispatch` now support:
    - `--context-file <path>` (repeatable)
    - `--context-repo <path>` (repeatable)
    - `--stdin` (diff/context piping)
  - `crew src <args...>` passthrough for optional `src` CLI workflows
- Added test coverage:
  - `tests/context-augment.test.js`
  - `tests/mcp.test.js`
  - `tests/headless.test.js`
- QA verification for this pass:
  - `npm run build` ✓
  - `npm run check` ✓
  - `npm test` ✓ (41 passing, 0 failing)
  - CLI smoke:
    - `crew --help` ✓
    - `crew headless --help` ✓
    - `crew mcp --help` ✓
    - `crew chat --help` (new context flags visible) ✓
    - `crew dispatch --help` (new context flags visible) ✓
    - `crew --headless --json -t \"...\"` shortcut path verified (blocked when paused) ✓

## ROI Hardening Pass (Strict/Artifacts/Budget/Safety) — 2026-02-28

- Added strict review CI gate:
  - `crew review --strict`
  - detects high-severity markers (`critical`, `severity: high`, `do not merge`, etc.)
  - exits non-zero when strict gate is tripped
- Added headless artifact output:
  - `crew --headless --json -t \"...\" --out .crew/headless-run.jsonl`
  - `crew headless run -t \"...\" --json --out <path>`
  - writes structured JSONL events for CI artifact upload
- Added context budget guard on `chat` and `dispatch`:
  - `--max-context-tokens <n>`
  - `--context-budget-mode trim|stop`
  - trim mode clips context to budget; stop mode exits with explicit error
- Added Sourcegraph safety preset:
  - `crew src batch-plan --query \"<pattern>\" [--repo <pattern>] [--spec <path>] [--execute]`
  - default behavior is dry-run plan/spec generation (safe by default)
- Added MCP health check:
  - `crew mcp doctor`
  - validates server URL format, required token env vars, and reachability
- Added/extended tests:
  - `tests/review.test.js`
  - `tests/sourcegraph.test.js`
  - expanded `tests/context-augment.test.js`
  - expanded `tests/headless.test.js`
  - expanded `tests/mcp.test.js`
- QA verification for this pass:
  - `npm run build` ✓
  - `npm run check` ✓
  - `npm test` ✓ (49 passing, 0 failing)
  - Command smoke checks:
    - `crew review --help` ✓
    - `crew headless run --help` ✓
    - `crew src batch-plan --query \"TODO\"` ✓
  - `crew dispatch ... --max-context-tokens ... --context-budget-mode stop` budget failure path ✓

## Full QA Audit Pass — 2026-02-28

- Added full-audit CI workflow:
  - `.github/workflows/full-audit.yml`
  - runs on push/PR + manual dispatch
- Added repository-wide QA gates:
  - `npm run test:coverage` (Node test runner coverage report)
  - `npm run qa:inventory` (ensures every `src/` file is covered by build graph and/or tests)
  - `npm run qa:smoke` (CLI command contract checks, including expected non-zero failure paths)
  - `npm run qa:full` (build + coverage + inventory + smoke)
- Added QA tooling:
  - `tools/qa-file-inventory.mjs`
  - `tools/qa-command-smoke.mjs`
- Verified locally:
  - `npm run qa:full` ✓

## Gateway/Engine E2E Harness — 2026-02-28

- Added end-to-end validation harnesses (rate-limit aware):
  - `tools/qa-gateway-contract.mjs`
  - `tools/qa-engine-matrix.mjs`
  - `tools/qa-pm-loop-e2e.mjs`
- Added npm commands:
  - `npm run qa:gateway-contract`
  - `npm run qa:engine-matrix`
  - `npm run qa:pm-loop`
  - `npm run qa:e2e` (runs all three)
- Added manual dispatch workflow:
  - `.github/workflows/e2e-engines.yml`
  - supports input gateway URL, timeout, require-gateway mode, and custom engine matrix JSON
- Behavior:
  - 429/rate-limit responses are marked `SKIP_RATE_LIMIT` (non-fatal)
  - non-rate-limit failures remain fatal
