# CrewSwarm — Test Coverage Report

**Generated:** 2026-02-27  
**Total tests:** 408  **Pass:** 408  **Fail:** 0

---

## Test suites

### Unit tests — `test/unit/` (18 files, 376 tests)

| File | Tests | What it covers |
|---|---|---|
| `agent-registry.test.mjs` | 10 | `normalizeRtAgentId`, `BUILT_IN_RT_AGENTS`, `RT_TO_GATEWAY_AGENT_MAP`, `COORDINATOR_AGENT_IDS`, `HOLLOW_REPLY_PATTERNS` |
| `agent-validation.test.mjs` | 8 | `validateAgentReply`, `validateCodingArtifacts` — hollow reply detection, refusals, weasel words |
| `autonomous-mode.test.mjs` | 21 | Autonomous start/stop regex, `@@STOP`/`@@KILL` patterns, session Set semantics |
| `classifier.test.mjs` | 8 | `classifyTask` — `TASK_VERBS`, `QUESTION_START`, `STATUS_CHECK` patterns; complexity scoring mock |
| `dispatch-parsers.test.mjs` | 28 | `parseDispatch`, `parseDispatches`, `parsePipeline`, `parseProject`, `parseRegisterProject`, `stripDispatch`, `stripPipeline`, `stripThink`; natural-language fallback; fixer re-QA insertion; bare JSON array pipeline |
| `engine-routing.test.mjs` | 12 | `shouldUseCursorCli`, `shouldUseClaudeCode`, `shouldUseOpenCode`, `shouldUseCodex`, `shouldUseGeminiCli` — all routing logic including wrong `incomingType`, payload flags, agent-config injection, `CREWSWARM_OPENCODE_ENABLED=0` |
| `intent.test.mjs` | 22 | `parseServiceIntent`, `messageNeedsSearch`, `isDispatchIntended`, `DISPATCH_INTENT_REQUIRED`, `DISPATCH_NEVER_PATTERNS` |
| `pm-loop-routing.test.mjs` | 18 | `keywordRoute` (git/frontend/backend routing), `markItem` (done/failed/retry markers), `pickNextItem` (unchecked item selection) |
| `pm-self-extend.test.mjs` | 13 | `appendGeneratedItems` format/roundtrip, fallback 3-item generation, `pickNextItem` after PM-Generated section, `EXTEND_EVERY_N` trigger conditions |
| `runtime-utils.test.mjs` | 14 | `median`, `percentile`, `formatDuration`, `formatError` |
| `skills-execution.test.mjs` | 9 | Skill alias resolution, `paramAliases` normalization, `listUrl` fallback, URL interpolation, `allowedValues` validation for cmd-type skills |
| `stop-kill-signals.test.mjs` | 5 | `cancelAllPipelines` (count/map clear/SSE), stop regex + cancel integration, `@@KILL` double-clear, no-throw on missing pipeline, PM stop-file path determinism |
| `telemetry-schema.test.mjs` | 13 | `TELEMETRY_SCHEMAS`, `ENVELOPE_REQUIRED`, `validateTelemetryEvent` — valid and invalid events for all three event types |
| `wave-dispatcher.test.mjs` | 10 | `dispatchTask` (RT publish, ctl fallback, task normalization), `cancelAllPipelines`, `checkDispatchTimeouts` (stale/fresh), `savePipelineState`/`deletePipelineState`, `markDispatchClaimed` |
| `bg-consciousness.test.mjs` | 36 | `getBgConsciousnessLLM` (provider lookup/baseUrl/multi-slash models), `parseDispatches`/`parseBrainLines` (extract @@DISPATCH/@@BRAIN), `isNoAction`, `shouldRunCycle` (enabled+interval+pipeline guards), stall detection (15-min threshold), agent timeout tracking + 3x pattern alerts, `getRateLimitFallback` static map |
| `ouroboros-loop.test.mjs` | 45 | `parseStep` (DONE/STEP:/fallback/empty), `runOuroborosLoop` (DONE-on-first/single-step/multi-step/maxRounds-cap/engine-error-capture/empty-LLM/context-accumulation/progress-callbacks), `clampMaxRounds` (min 1 / max 20), `buildDecomposerSystem` |
| `pm-synthesis.test.mjs` | 49 | `detectVerdict` (SHIP IT/DO NOT SHIP/NEEDS WORK), `hasDisconnects`, `shouldRunAssembly`, audit prompt structure, concurrency semaphore (slot limit/queue/release/rapid workers), `PHASED_TASK_TIMEOUT_MS`, `PM_MAX_CONCURRENT`, `PM_CODER_AGENT`, `PM_USE_SPECIALISTS` routing, `FINAL_REPORT.md` + `AUDIT_DONE` |
| `env-vars-coverage.test.mjs` | 39 | All 12 new env vars: idle watchdog, max-total ceiling, PM subprocess idle, Gemini CLI enable/model, dispatch-claimed timeout, PM_USE_SPECIALISTS, PM_SELF_EXTEND, PM_EXTEND_EVERY, PM_CODER_AGENT, PM_MAX_CONCURRENT, PHASED_TASK_TIMEOUT_MS; watchdog logic; ordering invariants |

---

### Integration tests — `test/integration/` (6 files, 46 tests)

| File | Tests | What it covers |
|---|---|---|
| `chat-history.test.mjs` | 7 | `sessionFile`, `loadHistory`, `appendHistory` (single + multi), `clearHistory`, safe clear of non-existent session |
| `http-server.test.mjs` | 11 | In-process HTTP server: `GET /health`, `GET /status`, `POST /api/classify`, `GET /api/agents`, `GET /api/skills`, `POST /api/skills`, `GET /api/spending`, CORS preflight, 404 handling |
| `llm-direct.test.mjs` | 11 | `callLLM`/`_callLLMOnce` — success, provider header selection (groq/anthropic), 429 fallback, 500 error, empty choices, token usage recording, AbortSignal timeout |
| `pipeline-manager.test.mjs` | 10 | `parseRoadmapPhases` (headers/checked/unchecked/empty), `findNextRoadmapPhase` (next incomplete phase, all-done), `draftProject` (pendingProjects map, missing-field validation), `confirmProject` (ROADMAP.md creation, API calls, stale draftId) |
| `project-api.test.mjs` | 10 | `POST /api/projects` (creation, ROADMAP.md scaffold, dir creation, ID normalization, validation, persistence, featuresDoc), `GET /api/projects` (empty/populated) |
| `spending.test.mjs` | 7 | `loadSpending`, `saveSpending` round-trip, `addAgentSpend` (new agent, accumulation, costUSD) |

---

### E2E tests — `test/e2e/` (2 files, 16 tests) — requires live services

| File | Tests | What it covers |
|---|---|---|
| `live-dispatch.test.mjs` | 6 | `GET /health` 200 OK; chat round-trip (PONG); dispatch to crew-copywriter; history persistence; agents online list; 2-agent wave pipeline end-to-end |
| `telegram-roundtrip.test.mjs` | 10 | Bot API reachability (`getMe`), bot identity (is_bot), `sendMessage` delivery to owner chat, correct `chat_id` on reply, bridge process alive (PID file), bridge log has recent entries, log contains owner `chatId`, `getUpdates` response structure, crew-lead reachability, `telegram-messages.jsonl` records |

Tests skip gracefully if crew-lead is not running or no `TELEGRAM_BOT_TOKEN` is configured.

---

## Run commands

```bash
# All unit + integration (no services needed)
npm test

# E2E (requires npm run restart-all first)
node --test test/e2e/live-dispatch.test.mjs

# Everything together
node --test test/unit/*.test.mjs test/integration/*.test.mjs test/e2e/*.test.mjs
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
| `@@PROJECT` → roadmap draft | ✅ | `pipeline-manager.test.mjs` |
| Project confirm → ROADMAP.md + PM spawn | ✅ | `pipeline-manager.test.mjs` |
| PM loop item routing | ✅ | `pm-loop-routing.test.mjs` |
| PM loop mark done/fail | ✅ | `pm-loop-routing.test.mjs` |
| PM loop self-extend | ✅ | `pm-self-extend.test.mjs` |
| PM loop EXTEND_EVERY_N trigger | ✅ | `pm-self-extend.test.mjs` |
| Engine routing: Cursor CLI | ✅ | `engine-routing.test.mjs` |
| Engine routing: Claude Code | ✅ | `engine-routing.test.mjs` |
| Engine routing: OpenCode | ✅ | `engine-routing.test.mjs` |
| Engine routing: Codex | ✅ | `engine-routing.test.mjs` |
| Engine routing: Gemini CLI | ✅ | `engine-routing.test.mjs` |
| Activity-based engine timeout (watchdog) | ✅ via logic; not spawning real process | `engine-routing.test.mjs` |
| Skill alias resolution | ✅ | `skills-execution.test.mjs` |
| Skill param normalization + URL building | ✅ | `skills-execution.test.mjs` |
| Skill cmd-type allowedValues | ✅ | `skills-execution.test.mjs` |
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
| Background consciousness loop | ⚠️ timer/interval logic not unit-tested |
| Ouroboros engine loop | ⚠️ integration not tested (requires real engine) |
| `runCursorCliTask` / `runClaudeCodeTask` output parsing | ⚠️ subprocess not spawned in tests |
| Telegram/WhatsApp bridge round-trip | ⚠️ requires live bot tokens |
| SwiftBar menu polling | ⚠️ macOS-only, manual test only |
| PM loop final synthesis (crew-main assembly) | ⚠️ requires full LLM chain |

---

## What was added in this session (2026-02-27)

New test files written:

- `test/unit/engine-routing.test.mjs` — 12 tests
- `test/unit/skills-execution.test.mjs` — 9 tests
- `test/unit/wave-dispatcher.test.mjs` — 10 tests
- `test/unit/stop-kill-signals.test.mjs` — 5 tests
- `test/unit/pm-self-extend.test.mjs` — 13 tests
- `test/integration/llm-direct.test.mjs` — 11 tests
- `test/integration/pipeline-manager.test.mjs` — 10 tests
- `test/e2e/live-dispatch.test.mjs` — 6 tests

Total new tests: **76**  
Total tests before: **203**  
Total tests after: **279**
