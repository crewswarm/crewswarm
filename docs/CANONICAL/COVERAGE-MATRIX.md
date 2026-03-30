# Coverage Matrix

**~2,510 tests | 211 files | 100% passing**

This document tracks what is genuinely covered by automated tests.

## Hermetic Coverage (offline, no services needed)

**~2,045 tests across 183 files**

- Core engine selection and fallback helpers
  - `test/unit/engine-routing.test.mjs`
  - `test/unit/engine-registry-selection.test.mjs`
  - `test/unit/engine-registry.test.mjs`
  - `test/unit/engine-settings-matrix.test.mjs`
  - `test/unit/ws-router-engine-fallback.test.mjs`
- Coordinator dispatch payload enrichment
  - `test/unit/coordinator-dispatch.test.mjs`
- Wave dispatcher, pipeline logic, quality gates
  - `test/unit/wave-dispatcher.test.mjs`
- RT envelope, DLQ, retry management
  - `test/unit/rt-envelope.test.mjs`, `test/unit/dlq.test.mjs`, `test/unit/retry-manager.test.mjs`
- PM loop logic, synthesis, judge decisions
  - `test/unit/pm-loop-routing.test.mjs`, `test/unit/pm-synthesis.test.mjs`, `test/unit/pm-judge-decisions.test.mjs`
- Agent registry, validation, permissions
  - `test/unit/agent-registry.test.mjs`, `test/unit/agent-validation.test.mjs`, `test/unit/agent-permissions.test.mjs`
- Session management, shared memory
  - `test/unit/session-manager.test.mjs`, `test/unit/shared-memory-adapter.test.mjs`
- Dashboard validation schemas
  - `test/unit/dashboard-validation.test.mjs`
- Background consciousness, autonomous mentions
  - `test/unit/bg-consciousness.test.mjs`, `test/unit/autonomous-mentions.test.mjs`
- Policy manager, spending caps
  - `test/unit/policy-manager.test.mjs`, `test/unit/spending.test.mjs`
- `crew-cli` runtime (82 files, 695 tests)
  - Sandbox, orchestrator, worker pool, context augmentation, strategies, risk scoring, prompt registry, model policies
- Messaging bridge contracts
  - `test/unit/bridge-integration.test.mjs`, `test/unit/messaging-bridges-contract.test.mjs`
- Startup guard and health contracts
  - `test/unit/startup-guard.test.mjs`, `test/unit/restart-health-contract.test.mjs`

## Integration / Bounded Verification (needs :4319 + :5010)

**~327 tests across 14 files**

- **All 147 dashboard API endpoints** smoke-tested
  - `test/integration/dashboard-api.test.mjs` — Zod schema validation for core endpoints
  - `test/integration/dashboard-api-full.test.mjs` — Route existence + response shape for every endpoint
- Dashboard workflow CRUD and API contracts
  - `test/integration/workflow-crud.test.mjs`
- Direct LLM fallback behavior
  - `test/integration/llm-direct.test.mjs`
- Dashboard agent settings persistence
  - `test/integration/agents-config-settings.test.mjs`
- Provider failover classification and fallback matrix
  - `test/integration/llm-failover-matrix.test.mjs`
- HTTP server endpoint coverage
  - `test/integration/http-server.test.mjs`
- Pipeline management
  - `test/integration/pipeline-manager.test.mjs`
- Chat history persistence
  - `test/integration/chat-history.test.mjs`
- Spending tracking
  - `test/integration/spending.test.mjs`

## UI / Browser Coverage (needs :4319 + Chrome)

**~34 tests across 2 files**

- **All 24 dashboard tabs** load and render without errors
  - `test/e2e/dashboard-tabs.test.mjs`
- Settings subtab navigation (5 subtabs)
- Cross-tab navigation stability
- Rapid tab switching stress test
- Chat send (click + enter) for both Chat and Swarm Chat tabs
  - `test/e2e/dashboard-chat-tabs.test.mjs`

## Live / Engine-Dependent (needs running services + CLI engines)

**~98 tests across 12 files**

- **All 6 CLI engines** respond via passthrough (Claude Code, Cursor, Gemini CLI, OpenCode, Codex, crew-cli)
  - `test/e2e/chat-passthrough-engines.test.mjs`
- **All 6 engines** create files on disk with content verification
  - `test/e2e/multi-engine-dispatch.test.mjs`
- **All 6 engines** produce structured build briefs via planner
  - `test/e2e/dashboard-build-planner-live.test.mjs`
- Pipeline wave execution (parallel + sequential)
  - `test/e2e/pipeline-waves-live.test.mjs`
- PM loop lifecycle (project, roadmap, dry-run, stop, logs)
  - `test/e2e/pm-loop-live.test.mjs`
- Multi-engine pipeline completion
  - `test/e2e/pm-loop-multi-engine.test.mjs`
- Live dispatch and reply
  - `test/e2e/live-dispatch.test.mjs`
- Surface dispatch (Dashboard + Vibe)
  - `test/e2e/surfaces-dispatch-live.test.mjs`
- Workflow CRUD lifecycle
  - `test/e2e/cron-workflow-live.test.mjs`
- **Dashboard lifecycle flows** (27 tests)
  - Settings toggle (read, change, verify, restore)
  - Agent config mutations with restore
  - Project CRUD (create, update, delete, verify)
  - DLQ read and conditional replay
  - Memory search and compact
  - File browser (directory listing + file content)
  - Services status (crew-lead + dashboard running)
  - RT message bus visibility
  - SSE event streaming verification
  - Engine runtime status
  - Token usage tracking
  - `test/e2e/dashboard-lifecycle.test.mjs`
- Telegram bridge roundtrip
  - `test/e2e/telegram-roundtrip.test.mjs`
- WhatsApp bridge roundtrip
  - `test/e2e/whatsapp-roundtrip.test.mjs`

## Manual QA Still Required

- Full native macOS `crewchat` interaction
- Full Dashboard/Vibe visual and responsive polish pass
- Provider billing and real vendor quota edge cases
- Production deploy health for external services
- Cross-surface accessibility checks
- Real Telegram/WhatsApp delivery through external networks (tests use local bridge, not carrier network)

## Test Reporting

Every test run generates:
- `test-results/runs/<runId>/run.json` — run metadata (git commit, branch, node version)
- `test-results/runs/<runId>/summary.json` — pass/fail counts, failure details
- `test-results/runs/<runId>/summary.md` — human-readable summary
- Per-test artifact directories with evidence files
- JSONL append log at `test-results/test-log.jsonl`
- Blast radius tracking via `npm run test:stale`

## Interpretation

- `Hermetic Coverage` = runs offline in CI without any services
- `Integration / Bounded` = needs dashboard + crew-lead running locally
- `UI / Browser` = needs Chrome + dashboard
- `Live / Engine-Dependent` = needs CLI engines installed + all services running
- See `docs/TESTING.md` for run commands and detailed descriptions
