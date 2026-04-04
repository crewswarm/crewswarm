# Coverage Matrix

**4,530 tests | 271 files | 100% passing (1 intentional skip)**

This document tracks what is genuinely covered by automated tests.

## Hermetic Coverage (offline, no services needed)

**~4,337 tests across 217 files**

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
  - `test/unit/pipeline-manager.test.mjs` — draft/confirm, roadmap parsing, auto-advance
- RT envelope, DLQ, retry management
  - `test/unit/rt-envelope.test.mjs`, `test/unit/dlq.test.mjs`, `test/unit/retry-manager.test.mjs`
- PM loop logic, synthesis, judge decisions
  - `test/unit/pm-loop-routing.test.mjs`, `test/unit/pm-synthesis.test.mjs`, `test/unit/pm-judge-decisions.test.mjs`
  - `test/unit/crew-judge.test.mjs` — heuristic + LLM judge decisions, fail-open behavior
- Agent registry, validation, permissions, daemon, tool instructions
  - `test/unit/agent-registry.test.mjs`, `test/unit/agent-validation.test.mjs`, `test/unit/agent-permissions.test.mjs`
  - `test/unit/agents-daemon.test.mjs` — PID management, heartbeat, spawn targets
  - `test/unit/agents-registry.test.mjs` — config helpers, agent maps, env override
  - `test/unit/agents-permissions.test.mjs` — tool names, role defaults, config-based permissions
  - `test/unit/agents-validation.test.mjs` — hollow/weasel pattern detection, prompt protocol
  - `test/unit/agents-tool-instructions.test.mjs` — CLI selection, tool permission building
- Session management, shared memory
  - `test/unit/session-manager.test.mjs`, `test/unit/shared-memory-adapter.test.mjs`
  - `test/unit/memory-shared-adapter.test.mjs` — broker lifecycle, recall, migration
- Dashboard validation schemas
  - `test/unit/dashboard-validation.test.mjs`
- Background consciousness, autonomous mentions
  - `test/unit/bg-consciousness.test.mjs`, `test/unit/autonomous-mentions.test.mjs`
- Policy manager, spending caps
  - `test/unit/policy-manager.test.mjs`, `test/unit/spending.test.mjs`
- Chat and conversation history
  - `test/unit/chat-history.test.mjs` — sanitization, JSONL persistence, MAX_HISTORY limits
  - `test/unit/chat-participants.test.mjs` — canonical IDs, @crew-all broadcast, deduplication
  - `test/unit/chat-project-messages.test.mjs` — project-scoped messages, filtering, tree building
  - `test/unit/chat-project-messages-rag.test.mjs` — RAG context, search result mapping
  - `test/unit/chat-unified-wrapper.test.mjs` — linked/unlinked user history paths
- Crew-lead internals
  - `test/unit/crew-lead-prompts.test.mjs` — system prompt building, memoization, agent roster
  - `test/unit/crew-lead-tools.test.mjs` — file I/O, command execution, blocked commands, web/telegram tools
  - `test/unit/crew-lead-background.test.mjs` — rate limit fallback, timeout recording, background loop
  - `test/unit/crew-lead-interval-manager.test.mjs` — SSE throttle, stale agent eviction
- Engine implementations
  - `test/unit/engines-opencode.test.mjs` — agent mapping, model priority, session continuity, noise filtering
  - `test/unit/engines-llm-direct.test.mjs` — OpenAI/Gemini paths, 429 retry, per-agent + Groq fallback
- Tools executor
  - `test/unit/tools-executor.test.mjs` — all @@tool tags, permission gates, command blocking, sandbox I/O
- Contacts and identity
  - `test/unit/contacts-identity-linker.test.mjs` — platform linking, master identity, DB lifecycle
- Bridges
  - `test/unit/bridges-integration.test.mjs` — skip conditions, platform registration, project detection
  - `test/unit/bridge-integration.test.mjs`, `test/unit/messaging-bridges-contract.test.mjs`
- Miscellaneous
  - `test/unit/cli-process-tracker.test.mjs` — process lifecycle, session status, stuck process detection
  - `test/unit/domain-planning.test.mjs` — domain detection, context building, routing
  - `test/unit/preferences-extractor.test.mjs` — extraction, domain gating, auto-save, profile building
  - `test/unit/integrations-code-search.test.mjs` — search, format, file/pattern finding
  - `test/unit/gemini-cli-passthrough-noise.test.mjs` — noise filtering, ANSI stripping, engine gating
- Root orchestrators and bridges
  - `test/unit/gateway-bridge.test.mjs` — b64url, transient error classification, text parsing, JSON safe parse, session ID extraction, retry logic
  - `test/unit/telegram-bridge.test.mjs` — message splitting, dedup, engine failure classification, chat history sanitization, model resolution, state machine, keyboard builders
  - `test/unit/whatsapp-bridge.test.mjs` — message splitting, dedup, JID routing, allowlist, display name resolution, TTS config, backoff, text extraction, command parsing
  - `test/unit/unified-orchestrator.test.mjs` — file path extraction, JSON validation, reply extraction, verification logic
  - `test/unit/natural-pm-orchestrator.test.mjs` — agent name normalization, natural language plan parsing (3 patterns)
  - `test/unit/deprecated-orchestrators.test.mjs` — exit code 1, deprecation message verification
- Startup guard and health contracts
  - `test/unit/startup-guard.test.mjs`, `test/unit/restart-health-contract.test.mjs`
- `crew-cli` runtime (88 files, 906 tests)
  - Sandbox, orchestrator, worker pool, context augmentation, strategies, risk scoring, prompt registry, model policies

## Integration / Bounded Verification (needs :4319 + :5010)

**~275 tests across 14 files**

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

## UI / Browser Coverage — Playwright (needs :4319 + Chrome)

**~222 tests across 17 spec files**

All specs capture `console.error` and `pageerror` via shared `helpers.mjs` — any unexpected browser error fails the test.

**All 19 dashboard tabs tested with real interactions:**

- `agents-tab.spec.js` — engine route buttons, model save, POST payload verification
- `contacts-tab.spec.js` — add/edit/delete contacts, search, platform badges, identity linking
- `models-tab.spec.js` — OAuth status badges, model dropdowns, test connection, provider key save
- `skills-tab.spec.js` — install/edit/delete skills, import URL, skill editor
- `swarm-tab.spec.js` — session list, engine selector, RT message phases, DLQ replay
- `swarm-chat-tab.spec.js` — send message, @mention autocomplete, autonomy toggle, project switch
- `waves-tab.spec.js` — wave cards, agent assignment, add/remove agents, save/reset config
- `projects-tab.spec.js` — create/edit/delete projects, PM loop start/stop, roadmap progress
- `spending-tab.spec.js` — cost breakdown, days selector, token cap, reset
- `usage-tab.spec.js` — token stats, by-model breakdown, tool matrix, agent restart
- `comms-tab.spec.js` — Telegram/WhatsApp config, bridge start/stop, message feeds
- `dashboard-tabs.spec.js` — Services cards, engine toggles, workflow CRUD
- `dashboard-additional-tabs.spec.js` — Build/PM Loop buttons, memory search, spending widget, prompt edit
- `dashboard-core-surfaces.spec.js` — Chat send, memory search, benchmarks leaderboard
- `providers-settings.spec.js` — provider key save, RT token, OpenCode settings

**Vibe editor/chat:**

- `vibe-editor.spec.js` — file tree, Monaco editor, autosave, chat send, project switch, mode selector
- `vibe-chat-routing.spec.js` — project selector, agent/CLI chat modes

**Puppeteer tab load tests (node:test E2E):**

- `test/e2e/dashboard-tabs.test.mjs` — all 24 tabs load and render
- `test/e2e/dashboard-chat-tabs.test.mjs` — chat click/enter send for Chat + Swarm Chat

## Live / Engine-Dependent (needs running services + CLI engines)

**~98 tests across 13 files**

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
