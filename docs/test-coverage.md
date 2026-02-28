# CrewSwarm — Test Coverage Report

**Generated:** 2026-02-27  
**Total tests:** 433  **Pass:** 433  **Fail:** 0

---

## Test suites

### Unit tests — `test/unit/` (18 files, 352 tests)

| File | Tests | What it covers |
|---|---|---|
| `agent-registry.test.mjs` | 10 | `normalizeRtAgentId`, `BUILT_IN_RT_AGENTS`, `RT_TO_GATEWAY_AGENT_MAP`, `COORDINATOR_AGENT_IDS`, `HOLLOW_REPLY_PATTERNS` |
| `agent-validation.test.mjs` | 8 | `validateAgentReply`, `validateCodingArtifacts` — hollow reply detection, refusals, weasel words |
| `autonomous-mode.test.mjs` | 21 | Autonomous start/stop regex, `@@STOP`/`@@KILL` patterns, session Set semantics |
| `bg-consciousness.test.mjs` | 36 | `getBgConsciousnessLLM` (provider lookup/baseUrl/multi-slash models), `parseDispatches`/`parseBrainLines`, `isNoAction`, `shouldRunCycle` (enabled+interval+pipeline guards), stall detection (15-min threshold), agent timeout tracking + 3x pattern alerts, `getRateLimitFallback` |
| `classifier.test.mjs` | 8 | `classifyTask` — `TASK_VERBS`, `QUESTION_START`, `STATUS_CHECK` patterns; complexity scoring mock |
| `dispatch-parsers.test.mjs` | 28 | `parseDispatch`, `parseDispatches`, `parsePipeline`, `parseProject`, `parseRegisterProject`, `stripDispatch`, `stripPipeline`, `stripThink`; natural-language fallback; fixer re-QA insertion; bare JSON array pipeline |
| `engine-routing.test.mjs` | 12 | `shouldUseCursorCli`, `shouldUseClaudeCode`, `shouldUseOpenCode`, `shouldUseCodex`, `shouldUseGeminiCli` — all routing logic including wrong `incomingType`, payload flags, agent-config injection, `CREWSWARM_OPENCODE_ENABLED=0` |
| `env-vars-coverage.test.mjs` | 39 | All 12 new env vars: idle watchdog, max-total ceiling, PM subprocess idle, Gemini CLI enable/model, dispatch-claimed timeout, PM_USE_SPECIALISTS, PM_SELF_EXTEND, PM_EXTEND_EVERY, PM_CODER_AGENT, PM_MAX_CONCURRENT, PHASED_TASK_TIMEOUT_MS; watchdog logic; ordering invariants |
| `intent.test.mjs` | 22 | `parseServiceIntent`, `messageNeedsSearch`, `isDispatchIntended`, `DISPATCH_INTENT_REQUIRED`, `DISPATCH_NEVER_PATTERNS` |
| `ouroboros-loop.test.mjs` | 45 | `parseStep` (DONE/STEP:/fallback/empty), `runOuroborosLoop` (DONE-on-first/single-step/multi-step/maxRounds-cap/engine-error-capture/empty-LLM/context-accumulation/progress-callbacks), `clampMaxRounds` (min 1 / max 20), `buildDecomposerSystem` |
| `pm-loop-routing.test.mjs` | 18 | `keywordRoute` (git/frontend/backend routing), `markItem` (done/failed/retry markers), `pickNextItem` (unchecked item selection) |
| `pm-self-extend.test.mjs` | 13 | `appendGeneratedItems` format/roundtrip, fallback 3-item generation, `pickNextItem` after PM-Generated section, `EXTEND_EVERY_N` trigger conditions |
| `pm-synthesis.test.mjs` | 49 | `detectVerdict` (SHIP IT/DO NOT SHIP/NEEDS WORK), `hasDisconnects`, `shouldRunAssembly`, audit prompt structure, concurrency semaphore (slot limit/queue/release/rapid workers), `PHASED_TASK_TIMEOUT_MS`, `PM_MAX_CONCURRENT`, `PM_CODER_AGENT`, `PM_USE_SPECIALISTS` routing, `FINAL_REPORT.md` + `AUDIT_DONE` |
| `runtime-utils.test.mjs` | 14 | `median`, `percentile`, `formatDuration`, `formatError` |
| `skills-execution.test.mjs` | 9 | Skill alias resolution, `paramAliases` normalization, `listUrl` fallback, URL interpolation, `allowedValues` validation for cmd-type skills |
| `stop-kill-signals.test.mjs` | 5 | `cancelAllPipelines` (count/map clear/SSE), stop regex + cancel integration, `@@KILL` double-clear, no-throw on missing pipeline, PM stop-file path determinism |
| `telemetry-schema.test.mjs` | 13 | `TELEMETRY_SCHEMAS`, `ENVELOPE_REQUIRED`, `validateTelemetryEvent` — valid and invalid events for all three event types |
| `wave-dispatcher.test.mjs` | 10 | `dispatchTask` (RT publish, ctl fallback, task normalization), `cancelAllPipelines`, `checkDispatchTimeouts` (stale/fresh), `savePipelineState`/`deletePipelineState`, `markDispatchClaimed` |

---

### Integration tests — `test/integration/` (6 files, 40 tests)

| File | Tests | What it covers |
|---|---|---|
| `chat-history.test.mjs` | 7 | `sessionFile`, `loadHistory`, `appendHistory` (single + multi), `clearHistory`, safe clear of non-existent session |
| `http-server.test.mjs` | 11 | In-process HTTP server: `GET /health`, `GET /status`, `POST /api/classify`, `GET /api/agents`, `GET /api/skills` (now returns `type: "api"\|"knowledge"`), `POST /api/skills`, `GET /api/spending`, CORS preflight, 404 handling |
| `llm-direct.test.mjs` | 11 | `callLLM`/`_callLLMOnce` — success, provider header selection (groq/anthropic), 429 fallback, 500 error, empty choices, token usage recording, AbortSignal timeout |
| `pipeline-manager.test.mjs` | 10 | `parseRoadmapPhases` (headers/checked/unchecked/empty), `findNextRoadmapPhase` (next incomplete phase, all-done), `draftProject` (pendingProjects map, missing-field validation), `confirmProject` (ROADMAP.md + PDD.md creation, API calls, stale draftId) |
| `project-api.test.mjs` | 10 | `POST /api/projects` (creation, ROADMAP.md scaffold, dir creation, ID normalization, validation, persistence, featuresDoc), `GET /api/projects` (empty/populated) |
| `spending.test.mjs` | 7 | `loadSpending`, `saveSpending` round-trip, `addAgentSpend` (new agent, accumulation, costUSD) |

---

### E2E tests — `test/e2e/` (4 files, 41 tests) — requires live services

| File | Tests | What it covers |
|---|---|---|
| `live-dispatch.test.mjs` | 6 | `GET /health` 200 OK; chat round-trip (PONG); dispatch to crew-copywriter; history persistence; agents online list; 2-agent wave pipeline end-to-end |
| `pm-loop-live.test.mjs` | 12 | Live PM loop execution: start/stop, roadmap item dispatch, agent routing, synthesize phase, ROADMAP.md updates |
| `telegram-roundtrip.test.mjs` | 10 | Bot API reachability (`getMe`), bot identity, `sendMessage` delivery, correct `chat_id`, bridge PID alive, log recent entries, log contains owner `chatId`, `getUpdates` structure, crew-lead reachability, `telegram-messages.jsonl` records |
| `whatsapp-roundtrip.test.mjs` | 13 | WhatsApp bridge reachability, auth persistence (`creds.json`), QR-scan state, PID alive (graceful skip if not running), log existence and recent entries, bridge singleton guard |

Tests skip gracefully if crew-lead is not running or required tokens are not configured.

---

## Run commands

```bash
# Unit + integration (no services needed) — default
npm test

# E2E only (requires npm run restart-all first)
npm run test:e2e

# Everything
npm run test:all
```

---

## Coverage by flow

| Flow | Tested? | Test file(s) |
|---|---|---|
| Direct LLM chat reply | ✅ | `llm-direct.test.mjs`, `http-server.test.mjs` |
| Service intent (restart agents, etc.) | ✅ | `intent.test.mjs` |
| `@@DISPATCH` parser + routing | ✅ | `dispatch-parsers.test.mjs`, `wave-dispatcher.test.mjs` |
| `@@PIPELINE` parser | ✅ | `dispatch-parsers.test.mjs` |
| Wave dispatch execution | ✅ | `wave-dispatcher.test.mjs`, `live-dispatch.test.mjs` |
| Wave quality gate (issues, QA fail auto-fix) | ✅ | `wave-dispatcher.test.mjs` |
| Wave timeout + auto-extend | ✅ | `wave-dispatcher.test.mjs` |
| `@@PROJECT` → roadmap + PDD draft | ✅ | `pipeline-manager.test.mjs` |
| Project confirm → ROADMAP.md + PDD.md + PM spawn | ✅ | `pipeline-manager.test.mjs` |
| PM loop item routing | ✅ | `pm-loop-routing.test.mjs` |
| PM loop mark done/fail | ✅ | `pm-loop-routing.test.mjs` |
| PM loop self-extend | ✅ | `pm-self-extend.test.mjs` |
| PM loop EXTEND_EVERY_N trigger | ✅ | `pm-self-extend.test.mjs` |
| PM loop final synthesis (audit + assembly) | ✅ | `pm-synthesis.test.mjs` |
| Background consciousness loop | ✅ | `bg-consciousness.test.mjs` |
| Ouroboros engine loop | ✅ | `ouroboros-loop.test.mjs` |
| Engine routing: Cursor CLI | ✅ | `engine-routing.test.mjs` |
| Engine routing: Claude Code | ✅ | `engine-routing.test.mjs` |
| Engine routing: OpenCode | ✅ | `engine-routing.test.mjs` |
| Engine routing: Codex | ✅ | `engine-routing.test.mjs` |
| Engine routing: Gemini CLI | ✅ | `engine-routing.test.mjs` |
| Activity-based engine watchdog timeout | ✅ | `engine-routing.test.mjs`, `env-vars-coverage.test.mjs` |
| Skills: API type (JSON endpoint) | ✅ | `skills-execution.test.mjs`, `http-server.test.mjs` |
| Skills: Knowledge type (SKILL.md) | ✅ | `skills-execution.test.mjs` |
| Skill alias resolution + param normalization | ✅ | `skills-execution.test.mjs` |
| `@@STOP` / `@@KILL` signals | ✅ | `stop-kill-signals.test.mjs`, `autonomous-mode.test.mjs` |
| Pipeline cancellation | ✅ | `stop-kill-signals.test.mjs`, `wave-dispatcher.test.mjs` |
| Chat history persistence | ✅ | `chat-history.test.mjs` |
| Agent validation (hollow replies) | ✅ | `agent-validation.test.mjs` |
| Autonomous mode start/stop | ✅ | `autonomous-mode.test.mjs` |
| Telemetry event validation | ✅ | `telemetry-schema.test.mjs` |
| Spending accumulation | ✅ | `spending.test.mjs` |
| LLM 429 fallback | ✅ | `llm-direct.test.mjs` |
| Live chat dispatch round-trip | ✅ | `live-dispatch.test.mjs` |
| Live wave pipeline (2 agents parallel) | ✅ | `live-dispatch.test.mjs` |
| Telegram bridge round-trip | ✅ | `telegram-roundtrip.test.mjs` |
| WhatsApp bridge state + singleton guard | ✅ | `whatsapp-roundtrip.test.mjs` |
| PRD interview flow (Stinki prompt) | ✅ via prompt unit tests | `dispatch-parsers.test.mjs` |
| PDD.md auto-generation on project confirm | ✅ | `pipeline-manager.test.mjs` |
| `runCursorCliTask` / `runClaudeCodeTask` output parsing | ⚠️ subprocess not spawned in tests | — |
| SwiftBar menu polling | ⚠️ macOS-only, manual test only | — |

---

## Session changelog

### 2026-02-27 — Session 3 additions (+154 tests, 279→433)

| Added | Tests | What |
|---|---|---|
| `bg-consciousness.test.mjs` | 36 | Background consciousness loop — full provider/interval/stall/alert logic |
| `ouroboros-loop.test.mjs` | 45 | Ouroboros LLM↔engine loop — parse/run/clamp/decompose |
| `pm-synthesis.test.mjs` | 49 | PM final synthesis — verdict detection, semaphore, phase routing |
| `env-vars-coverage.test.mjs` | 39 | All 12 new env vars + watchdog logic |
| `telegram-roundtrip.test.mjs` | 10 | Telegram E2E round-trip |
| `whatsapp-roundtrip.test.mjs` | 13 | WhatsApp bridge E2E + singleton guard |
| `pm-loop-live.test.mjs` | 12 | Live PM loop execution against real services |

### 2026-02-27 — Session 2 additions (+76 tests, 203→279)

| Added | Tests | What |
|---|---|---|
| `engine-routing.test.mjs` | 12 | All 5 engine routing functions |
| `skills-execution.test.mjs` | 9 | Skill alias/param/URL logic |
| `wave-dispatcher.test.mjs` | 10 | Wave dispatch, timeout, pipeline state |
| `stop-kill-signals.test.mjs` | 5 | @@STOP/@@KILL signal handling |
| `pm-self-extend.test.mjs` | 13 | PM self-extend + EXTEND_EVERY_N |
| `llm-direct.test.mjs` | 11 | Direct LLM calls + 429 fallback |
| `pipeline-manager.test.mjs` | 10 | Project draft/confirm + roadmap phases |
| `live-dispatch.test.mjs` | 6 | Live E2E dispatch + wave |
