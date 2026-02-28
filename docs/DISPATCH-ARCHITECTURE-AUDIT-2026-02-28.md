# Dispatch Architecture Audit (2026-02-28)

## Summary

Claude Code mapped **25 distinct dispatch entry points** across CrewSwarm's codebase, identifying 4 core dispatch patterns and several architectural concerns.

---

## 4 Core Dispatch Patterns

### Pattern 1: `gateway-bridge --send` (spawn-based)
**Used by:** pm-loop, unified-orchestrator, natural-pm-orchestrator, phased-orchestrator

```
caller → spawn("node", [gateway-bridge.mjs, "--send", agentId, message])
       → RT bus publish OR fallback to Cursor CLI spawn
       → agent processes → done.jsonl
```

### Pattern 2: REST `/api/dispatch` → RT bus
**Used by:** crew-cli dispatch, ai-pm, MCP server, scheduled pipelines, crew-cli ci-fix/watch

```
POST /api/dispatch {agent, task}
  → wave-dispatcher.mjs dispatchTask()
  → ws.send({type: "command.run_task", to: agent})
  → RT bus → agent → done channel
```

### Pattern 3: `@@DISPATCH` / `@@PIPELINE` tag parsing
**Used by:** chat-handler (LLM replies), dashboard chat

```
LLM reply contains: @@DISPATCH {"agent":"crew-coder","task":"..."}
  → parsers.mjs extracts JSON
  → dispatchTask() (same as Pattern 2)
```

### Pattern 4: Wave/Pipeline orchestration
**Used by:** crew-lead wave-dispatcher, ai-pm project loops

```
Pipeline = [[wave1-tasks], [wave2-tasks], ...]
  → dispatch all wave-1 tasks in parallel
  → wait for all to complete
  → QA quality gate check
  → if FAIL: auto-insert crew-fixer wave
  → advance to wave 2
```

---

## 25 Entry Points Identified

| # | Entry Point | File | Agent Selection | Pattern |
|---|---|---|---|---|
| 1 | `node pm-loop.mjs` | pm-loop.mjs:916 | LLM/regex routing | Pattern 1 |
| 2 | `POST /api/dispatch` | http-server.mjs:317 | Caller specifies | Pattern 2 |
| 3 | Wave pipeline dispatch | wave-dispatcher.mjs:503 | Per-wave config | Pattern 4 |
| 4 | Cursor wave orchestrator | wave-dispatcher.mjs:277 | crew-orchestrator | Pattern 4 |
| 5 | unified-orchestrator | unified-orchestrator.mjs:305 | PM plan parsing | Pattern 1 |
| 6 | natural-pm-orchestrator | natural-pm-orchestrator.mjs:148 | NL plan parsing | Pattern 1 |
| 7 | BG consciousness | background.mjs:135 | crew-main | Pattern 1 |
| 8 | `@@DISPATCH` parsing | chat-handler.mjs:113 | LLM-chosen | Pattern 3 |
| 9 | `@@PIPELINE` parsing | chat-handler.mjs:732 | Wave config | Pattern 3 |
| 10 | `gateway-bridge --send` | gateway-bridge.mjs:1548 | CLI param | Pattern 1 |
| 11 | `gateway-bridge --broadcast` | gateway-bridge.mjs:1127 | All agents | Pattern 1 |
| 12 | `crew dispatch` | crew.mjs:2762 | CLI param | Pattern 2 |
| 13 | `crew watch` | crew.mjs:3371 | crew-coder (hardcoded) | Pattern 2 |
| 14 | `crew ci-fix` | crew.mjs:3449 | crew-fixer (hardcoded) | Pattern 2 |
| 15 | `crew browser-fix` | crew.mjs:3419 | crew-fixer (hardcoded) | Pattern 2 |
| 16 | `crew code-review` | crew.mjs:3010 | Specified agent | Pattern 2 |
| 17 | Telegram bridge | telegram-bridge.mjs:372 | Intent extraction | Pattern 2 |
| 18 | WhatsApp bridge | whatsapp-bridge.mjs:248 | Intent extraction | Pattern 2 |
| 19 | ai-pm.mjs | ai-pm.mjs:237 | Hardcoded sequence | Pattern 2 |
| 20 | MCP smart_dispatch | mcp-server.mjs:345 | LLM analysis | Pattern 2 |
| 21 | MCP dispatch_agent | mcp-server.mjs:221 | Caller specifies | Pattern 2 |
| 22 | phased-orchestrator | phased-orchestrator.mjs:49 | Phase-based | Pattern 1 |
| 23 | Scheduled pipeline | run-scheduled-pipeline.mjs:65 | Config | Pattern 2 |
| 24 | Dashboard /api/send | dashboard.mjs:413 | Caller specifies | openswitchctl |
| 25 | OpenCode RT daemon | opencrew-rt-daemon.mjs:227 | RT `to:` field | Pattern 2 |

---

## Issues Identified

### ✅ ALREADY FIXED

**#6: `pm-loop.mjs` line 412 — `require()` in ESM**

**Status:** ✅ Fixed in PM Loop Deep Audit (see `docs/PM-LOOP-DEEP-AUDIT-2026-02-28.md`)

---

### ⚠️ ARCHITECTURAL CONCERNS (Not Breaking)

#### #1: Overlapping Orchestrators

**Issue:** Three separate orchestrator files exist with overlapping functionality:
- `unified-orchestrator.mjs` (plan → dispatch JSON)
- `natural-pm-orchestrator.mjs` (NL plan → dispatch)
- `phased-orchestrator.mjs` (multi-phase)

All use the same `spawn gateway-bridge --send` pattern but with different planning logic.

**Impact:** Code duplication, harder maintenance, unclear which to use when.

**Recommendation:** Consider consolidating into a single configurable orchestrator with different "modes".

**Status:** ⏳ Not fixed (design refactor, not urgent)

---

#### #2: Multiple `dispatchTask()` Implementations

**Issue:** At least 3 different `dispatchTask()` functions exist:
- `wave-dispatcher.mjs:503` (RT bus publish)
- `natural-pm-orchestrator.mjs:148` (spawn --send)
- `ai-pm.mjs:237` (REST POST to /api/dispatch)

**Impact:** Inconsistent behavior, different error handling, telemetry gaps.

**Recommendation:** Extract a canonical `dispatchTask()` to a shared module, have all callers use it.

**Status:** ⏳ Not fixed (refactoring opportunity)

---

#### #3: Hardcoded Agent Fallbacks (crew-cli only)

**Issue:** `crew watch`, `crew ci-fix`, and `crew browser-fix` hardcode their target agents:
- `crew watch` → `crew-coder`
- `crew ci-fix` → `crew-fixer`
- `crew browser-fix` → `crew-fixer`

**Impact:** If user has renamed agents or doesn't have these in their config, commands silently fail.

**Note:** These files are in `crew-cli` (separate project), not in the main CrewSwarm repo.

**Status:** ⏳ Not applicable to main repo

---

#### #4: RT_TO_GATEWAY_AGENT_MAP — False Positive

**Issue (reported):** Claimed there were two different `RT_TO_GATEWAY_AGENT_MAP` exports that could drift.

**Actual Status:** ✅ NOT AN ISSUE — `lib/agents/registry.mjs` **imports** from `lib/agent-registry.mjs` (line 12), it doesn't duplicate the map. Single source of truth confirmed.

**Status:** ✅ Verified safe

---

#### #5: Dashboard `openswitchctl` Bypass

**Issue:** Entry point #24 (`dashboard.mjs:413`) uses `openswitchctl` shell script, which bypasses:
- RT bus queue limits
- Dispatch guards
- Telemetry
- Standard error handling

**Impact:** Inconsistent behavior when dispatching through dashboard vs other entry points.

**Recommendation:** Refactor dashboard to use standard `/api/dispatch` endpoint instead of `openswitchctl`.

**Status:** ⏳ Not fixed (legacy compatibility concern)

---

## Dispatch Flow Diagram

```
Entry Points (25)
    ↓
┌───────────────────────────────────────────────────────────┐
│ Pattern 1: spawn gateway-bridge --send                    │
│ Pattern 2: POST /api/dispatch → RT bus                    │
│ Pattern 3: @@DISPATCH tag parsing → Pattern 2             │
│ Pattern 4: Wave orchestration → parallel Pattern 2        │
│ Special: openswitchctl → direct spawn (bypasses RT bus)   │
└───────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────┐
│ Agent Execution                                            │
│ - RT bus agents (via OpenCode/Cursor)                     │
│ - CLI fallback agents (spawn Cursor/Codex/etc)            │
└───────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────┐
│ Result Handling                                            │
│ - done.jsonl files                                         │
│ - RT bus done channel                                      │
│ - HTTP response                                            │
└───────────────────────────────────────────────────────────┘
```

---

## Verification

**Files checked:**
- ✅ `lib/agent-registry.mjs` (canonical source)
- ✅ `lib/agents/registry.mjs` (imports from above)
- ✅ `pm-loop.mjs` (require() bug already fixed)
- ✅ Orchestrator files (3 found, overlapping but not broken)
- ✅ dispatchTask implementations (3 found, inconsistent but functional)

**Test status:**
- Same pre-existing test failures (engine-routing, PM stop detection)
- No new failures introduced

---

## Recommendations Priority

1. **DONE** ✅ — Fix `require()` in ESM (already fixed)
2. **DONE** ✅ — Verify RT_TO_GATEWAY_AGENT_MAP (confirmed single source)
3. **OPTIONAL** — Refactor dashboard to use `/api/dispatch` instead of `openswitchctl`
4. **OPTIONAL** — Extract canonical `dispatchTask()` to shared module
5. **OPTIONAL** — Consolidate orchestrators into single configurable implementation

---

## Summary

- **Critical bugs:** 0 (all fixed)
- **Architectural debt:** Medium (overlapping implementations, but functional)
- **Breaking issues:** None
- **Documentation gaps:** High (25 entry points, limited docs on which to use when)

The dispatch architecture is **functional but complex**. The multiple overlapping patterns work correctly but create maintenance burden and onboarding friction.
