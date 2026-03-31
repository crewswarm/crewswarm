# crew-cli Architecture Overhaul Plan

## Status: 7/10 phases complete. Phase 0 (OAuth) is next.

---

## Phase 0: OAuth Token Reuse ⭐ NEXT

### 0a. Read Claude Max OAuth from macOS Keychain (TODO — HIGHEST PRIORITY)
- Claude Code stores OAuth tokens in macOS Keychain at service `"Claude Code-credentials"`
- Read with: `security find-generic-password -a "$(whoami)" -s "Claude Code-credentials" -w`
- Returns JSON: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType } }`
- Your token: `subscriptionType: "max"`, `rateLimitTier: "default_claude_max_5x"`, scopes include `user:inference`
- Use `accessToken` as `Authorization: Bearer ${token}` against Anthropic API
- This gives crew-cli free Claude Opus 4.6 on your Max subscription — no API key charges
- Need token refresh handling: check `expiresAt`, use `refreshToken` to get new access token
- File: new `crew-cli/src/auth/oauth-keychain.ts`
- Wire into `crew-cli/src/executor/agentic-executor.ts` → `resolveProvider()` as highest-priority provider

### 0b. Read Codex/OpenCode OAuth tokens (TODO)
- Codex CLI stores ChatGPT Pro OAuth somewhere — find keychain entry or `~/.codex/` config
- OpenCode stores OAuth at `~/.local/share/opencode/auth.json`
- Extract bearer tokens → crew-cli can call OpenAI models via OAuth too
- Combined: crew-cli gets Opus 4.6 + GPT-5.4 + Gemini all on subscriptions, zero API cost

### 0c. Provider fallback chain (TODO)
- Priority: OAuth token (free) → API key (paid) → free-tier model (gemini-2.5-flash)
- crew-cli tries OAuth first, falls back to API key only if OAuth unavailable/expired
- File: update `crew-cli/src/executor/agentic-executor.ts` → `resolveProvider()`

### Reference (TS source for OAuth implementation)
- Token storage: `/tmp/claude-src/src/utils/secureStorage/macOsKeychainStorage.ts`
- Token loading: `/tmp/claude-src/src/utils/auth.ts` line 1255 `getClaudeAIOAuthTokens()`
- OAuth client: `/tmp/claude-src/src/services/oauth/client.ts`
- Token refresh: `/tmp/claude-src/src/services/oauth/client.ts` → `refreshOAuthToken()`
- Keychain service name: `"Claude Code" + "" + "-credentials"` = `"Claude Code-credentials"`
- TS source: extract from `~/Downloads/src.zip` to `/tmp/claude-src/`

---

## Phase 1: Tool Safety ✅ DONE

### 1a. Read-before-edit guard ✅ DONE
- `write_file` rejects existing files → forces `replace`
- `replace`/`edit` requires prior `read_file` call
- `append_file` requires prior `read_file` for existing files

### 1b. Trust-gated tool filtering ✅ DONE
- 3 constraint levels: `read-only`, `edit`, `full`
- Tools REMOVED from declaration list (LLM can't call what doesn't exist)
- Hard enforcement at `executeTool()` even if LLM somehow calls a removed tool
- `constraintLevelForPersona()` auto-maps worker types to levels
- Wired through `runAgenticWorker()` → `GeminiToolAdapter` → pipeline

---

## Phase 2: Project Understanding (PARTIAL)

### 2a. Immutable ProjectContext ✅ DONE
- Frozen snapshot at session start: file tree, tech stack, key configs
- 10 tech stacks detected (static-html, node-js, node-ts, python, go, rust, java, ruby, php, unknown)
- Auto-generates constraints (e.g., "This is static HTML — do NOT use require/import")
- Injected into both `l3ExecuteSingle` and `l3ExecuteParallel` worker prompts
- Singleton-cached — built once per session

### 2b. Codebase RAG improvements (TODO)
- Already exists at `crew-cli/src/context/codebase-rag.ts`
- Verify it triggers for parallel workers (may only work for single execution)
- Add import-graph mode (trace imports from changed files)
- Inject RAG results into worker context overlay

---

## Phase 3: Execution Quality (PARTIAL)

### 3a. Structured failure returns ✅ DONE
- `ToolResult` now has `handled` (boolean) and `recovery` (string hint)
- Guard errors (read-before-edit, write-existing, constraint block) return `handled: false` + recovery hint
- `executeToolWithRetry` propagates non-retryable errors with `[RECOVERY HINT]` for the LLM
- QA gate checks for unhandled errors in transcript

### 3b. Edit strategy layering (TODO)
- Already partially exists in `crew-cli/src/tools/gemini/edit.ts`
- Full chain: exact match → flexible whitespace → regex → fuzzy (Levenshtein) → LLM fix
- Fuzzy threshold: 10% weighted difference
- On failure: FixLLMEditWithInstruction retry (ask LLM to fix its own edit)
- Verify this is wired into crew-adapter's editFile method

---

## Phase 4: Execution Tracking ✅ DONE

### 4a. Execution transcript/registry ✅ DONE
- New `ExecutionTranscript` class — append-only, immutable after `freeze()`
- Every tool call logged: `{ts, toolName, params, success, outputPreview, durationMs, error, handled, recovery}`
- Computed properties: `filesRead`, `filesEdited`, `filesWritten`, `unreadEdits`, `failedShellCommands`
- Returned on `AgenticExecutorResult` for QA consumption

### 4b. Deterministic QA gate ✅ DONE
- 7 mechanical checks before LLM QA runs:
  1. read-before-edit (all edited files were read first)
  2. no-overwrites (write_file + edit on same file)
  3. shell-success (no failed shell commands)
  4. within-budget (tool call count vs turn budget)
  5. files-changed (actually produced changes)
  6. no-unhandled-errors (constraint blocks, etc.)
  7. no-stuck-loops (same failing tool call >= 3 times)
- Integrated into pipeline — runs on every execution, flags escalation

---

## Phase 5: Pipeline Architecture (PARTIAL)

### 5a. Bootstrap graph ✅ DONE
- Expanded `PipelineRunState` phases: init → scan → route → plan → validate-plan → execute → evidence → validate → qa → checkpoint → complete
- Allows forward-skipping (direct-answer skips execute..checkpoint)
- Phase timing tracked with `durationMs` per entry
- Pipeline executes: scan (ProjectContext) → plan → execute → transcript QA → validate → checkpoint → complete

### 5b. Token compaction (TODO)
- Track context usage per conversation
- At 75% of model's context window: auto-summarize middle messages
- Keep first 2 + last 6 messages intact
- Already exists at `crew-cli/src/context/token-compaction.ts` — verify it's active
- Critical for long multi-turn worker sessions

---

## Phase 6: Effort-Based Routing (TODO)

### 6a. Explicit effort tiers per request
- Classify user input into effort levels at L1:
  - `low`: typo fix, rename, one-liner → 1-3 turns, cheapest model (gemini-flash)
  - `medium`: single feature, bug fix, add section → 5-10 turns, mid model (gpt-5.2)
  - `high`: multi-file feature, API, refactor → 15-25 turns, best model (opus via OAuth)
- L1 router already classifies DIRECT-ANSWER vs EXECUTE-DIRECT vs EXECUTE-PARALLEL
- Extend: add `estimatedEffort: low|medium|high` to the routing decision
- Wire into `runAgenticWorker()` → pick model + maxTurns based on effort
- User can override: `crew chat --effort high "fix the typo"` forces best model
- File: update `crew-cli/src/pipeline/unified.ts` L1 routing prompt + `resolveProvider()`

### 6b. Per-layer model selection
- Currently hardcoded: L3 workers always use `CREW_EXECUTION_MODEL || gemini-2.5-flash`
- Make configurable per layer:
  ```
  CREW_L1_MODEL=gemini-2.5-flash          # routing (free, fast)
  CREW_L2A_MODEL=gpt-5.2                  # planning (medium)
  CREW_L2B_MODEL=gemini-2.5-flash         # plan validation (free)
  CREW_L3_MODEL=gemini-2.5-flash          # execution (free, has tools)
  CREW_L3_REVIEW_MODEL=gemini-2.5-flash   # reviewer (cheap is fine)
  CREW_L3_FIXER_MODEL=gpt-5.2-codex      # fixer (needs coding skill)
  ```
- With OAuth (Phase 0): swap any layer to opus/gpt-5.4 for free

---

## Phase 7: Dual-Model Advisor (L3 Review) (TODO)

### 7a. L3 reviewer as separate model pass
- After L3 worker completes, run a DIFFERENT model as reviewer:
  1. Worker (model A) writes code → produces transcript + diff
  2. Reviewer (model B) reads the diff + transcript + ProjectContext
  3. Reviewer outputs: `{ approved: bool, issues: string[], severity: string }`
  4. If issues found → L3 fixer (model C or A) addresses them
- Reviewer prompt is simple — doesn't need tools, just reads context:
  ```
  Review this diff against the original task. Check:
  - Does it match the tech stack? (no Node.js in browser projects)
  - Are there obvious bugs? (undefined vars, broken imports, missing functions)
  - Did the worker follow the task requirements?
  - Any security issues? (hardcoded secrets, injection, XSS)
  Return JSON: { approved, issues[], severity }
  ```
- Cheap model (gemini-flash) is perfect — review is pattern matching, not creation
- File: new `crew-cli/src/executor/reviewer.ts`
- Wire into pipeline after execute phase, before QA validate

### 7b. Cross-model blind spot elimination
- Key insight: different models have different failure modes
  - Gemini hallucinates imports, Claude hallucinates file contents, GPT over-abstracts
  - Model A's bugs are model B's obvious catches
- Reviewer model should be a DIFFERENT provider than the worker:
  - Worker: gemini-flash → Reviewer: gpt-5.2 (or claude-sonnet via OAuth)
  - Worker: gpt-5.2-codex → Reviewer: gemini-flash
- Configurable via `CREW_L3_REVIEW_MODEL` env var
- Cost: one extra cheap LLM call per task (~$0.001 for flash review)

### 7c. Deterministic + LLM hybrid review
- Phase 4b deterministic QA runs FIRST (7 mechanical checks)
- If mechanical checks pass → L3 reviewer runs (LLM review with different model)
- If reviewer flags issues → fixer runs → re-review
- Max 2 review cycles (prevent infinite loops)
- Pipeline: execute → deterministic QA → LLM review → fix → re-review → checkpoint

---

## Phase 8: Token Efficiency (TODO)

### 8a. Compressed tool schemas after first turn
- First turn: send full tool declarations (names, descriptions, parameter schemas)
- Subsequent turns: send only tool names (model already knows the schemas)
- OpenAI and Gemini cache function declarations per-conversation
- For Anthropic: use `token-efficient-tools` beta header when available
- Estimated savings: ~2K tokens per turn × 10 turns = 20K tokens saved per task

### 8b. Token compaction (Phase 5b)
- Already exists at `crew-cli/src/context/token-compaction.ts` — verify active
- At 75% context: summarize middle messages, keep first 2 + last 6
- Critical for L3 workers doing 15+ turn sessions

---

## Remaining TODO (priority order)

| # | Phase | What | Effort | Impact |
|---|-------|------|--------|--------|
| 1 | 0a | Claude OAuth from keychain | 2-3 hrs | Free Opus 4.6 for all crew-cli ops |
| 2 | 0b | Codex/OpenCode OAuth tokens | 1-2 hrs | Free GPT-5.4 for crew-cli |
| 3 | 0c | Provider fallback chain | 1 hr | OAuth → API key → free model |
| 4 | 7a | L3 reviewer (cheap model, different provider) | 2 hrs | Catches cross-model blind spots |
| 5 | 6a | Effort-based routing | 1-2 hrs | Right model for the job |
| 6 | 6b | Per-layer model selection | 1 hr | Full control over cost/quality |
| 7 | 3b | Edit strategy layering | 1-2 hrs | Better edit success rate |
| 8 | 2b | Codebase RAG for parallel workers | 1 hr | Better context per worker |
| 9 | 8a | Compressed tool schemas | 1 hr | ~20K tokens saved per task |
| 10 | 5b/8b | Token compaction | 1 hr | Handles long sessions |

---

## Reference Material

- Claude Code TS source: extract `~/Downloads/src.zip` to `/tmp/claude-src/` (1,884 files, 33MB)
  - Tool system: `src/Tool.ts`, `src/tools/`
  - OAuth: `src/utils/auth.ts`, `src/services/oauth/`, `src/utils/secureStorage/`
  - Context: `src/context.ts`
  - Coordinator: `src/coordinator/`
  - Bootstrap: `src/bootstrap/`
  - Main: `src/main.tsx` (803KB)
- Python rewrite: `https://github.com/instructkr/claw-code` (35K stars)
- Architecture analysis: saved in memory `project_crew_cli_overhaul.md`

---

## Commands to test after each change
```bash
# Rebuild
cd crew-cli && npm run build

# Test single execution (should read files, use replace, not overwrite)
NODE_DISABLE_COMPILE_CACHE=1 node bin/crew.js chat "add a hello world section to index.html" --apply --project /Users/jeffhobbs/Chuck

# Verify tools used
cat /Users/jeffhobbs/Chuck/.crew/pipeline-runs/pipeline-*.jsonl | python3 -c "
import sys,json
for l in sys.stdin:
    d = json.loads(l)
    if 'validate' in d.get('phase',''):
        r = d.get('executionResults',{}).get('results',[{}])[0]
        print(f'tools={r.get(\"toolsUsed\",[])} files={r.get(\"filesChanged\",[])} turns={r.get(\"turns\",0)}')
"

# Check no file overwrites
cd /Users/jeffhobbs/Chuck && git diff --stat
```
