# crew-cli Architecture Overhaul Plan

## Status: Phase 0-1a done, Phase 0 next priority
## Priority: Ship in order, each builds on the previous

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

---

## Phase 1: Tool Safety ✅ DONE

### 1a. Read-before-edit guard ✅ DONE
- `write_file` rejects existing files → forces `replace`
- `replace`/`edit` requires prior `read_file` call
- `append_file` requires prior `read_file` for existing files
- Files: `crew-cli/src/tools/gemini/crew-adapter.ts`

### 1b. Trust-gated tool filtering (TODO)
- Instead of telling the LLM "don't use write_file" → REMOVE it from the tool list
- Create 3 constraint levels:
  - `read-only`: read_file, grep, glob, list_directory (for planners/reviewers)
  - `edit`: above + replace, append_file, run_shell_command (for coders)
  - `full`: above + write_file, git, spawn_agent (for scaffolders)
- Worker type determines level: `executor-code` → edit, `executor-scaffold` → full
- File: `crew-cli/src/tools/gemini/crew-adapter.ts` → new `getToolDeclarationsForLevel(level)` method
- Wire into `runAgenticWorker()` in `crew-cli/src/executor/agentic-executor.ts`

---

## Phase 2: Project Understanding

### 2a. Immutable ProjectContext (TODO)
- Build frozen project snapshot at session start:
  - File tree (name, type, size, last modified)
  - Tech stack detection (static HTML, Node.js, TypeScript, Python, etc.)
  - Key config files (package.json deps, tsconfig, .gitignore patterns)
  - Import graph (which files import which — for understanding coupling)
- Inject into EVERY system prompt (L1 router, L2 planner, L3 workers)
- Workers stop creating Node.js modules for browser projects
- File: new `crew-cli/src/context/project-context.ts`
- ~200 lines. Build once, freeze, reuse.

### 2b. Codebase RAG improvements (TODO)
- Already exists at `crew-cli/src/context/codebase-rag.ts`
- Verify it triggers for parallel workers (may only work for single execution)
- Add import-graph mode (trace imports from changed files)
- Inject RAG results into worker context overlay

---

## Phase 3: Execution Quality

### 3a. Structured failure returns (TODO)
- Current: tool errors return string `{ success: false, error: "..." }`
- New: return `{ success: false, error: "...", handled: false, recovery: "call read_file first" }`
- Execution loop checks `handled` — if false, forces worker to address it
- Prevents workers from ignoring errors and claiming success
- File: `crew-cli/src/tools/gemini/crew-adapter.ts` (ToolResult type)

### 3b. Edit strategy layering (TODO)
- Already partially exists in `crew-cli/src/tools/gemini/edit.ts`
- Full chain: exact match → flexible whitespace → regex → fuzzy (Levenshtein) → LLM fix
- Fuzzy threshold: 10% weighted difference
- On failure: FixLLMEditWithInstruction retry (ask LLM to fix its own edit)
- Verify this is wired into crew-adapter's editFile method

---

## Phase 4: Execution Tracking

### 4a. Execution transcript/registry (TODO)
- Append-only log of every tool call per task:
  ```
  { ts, toolName, params, success, output_preview, duration_ms }
  ```
- Immutable — workers can't modify after completion
- QA gate reads transcript to verify work
- File: new `crew-cli/src/execution/transcript.ts`
- Wire into `executeTool()` in agentic-executor.ts

### 4b. Deterministic QA gate (TODO)
- Current: LLM judges "did this work?" (unreliable)
- New: mechanical checks against transcript:
  - All required files read before edit? ✓/✗
  - No file overwrites (only surgical edits)? ✓/✗
  - Worker stayed within turn/token budget? ✓/✗
  - Shell commands succeeded? ✓/✗
  - Files actually changed on disk? ✓/✗
- LLM QA only runs if mechanical checks pass
- File: update `crew-cli/src/pipeline/unified.ts` → `passesDeterministicSmallTaskGate()`

---

## Phase 5: Pipeline Architecture

### 5a. Bootstrap graph (TODO)
- Strict ordered stages replacing the loose pipeline:
  1. **Scan**: build ProjectContext
  2. **Route**: L1 classify (with project context)
  3. **Plan**: L2 decompose (with project context + codebase RAG)
  4. **Validate plan**: check work units are well-formed
  5. **Execute**: L3 workers (with tools filtered by trust level)
  6. **Collect evidence**: build transcript + file diffs
  7. **QA validate**: deterministic checks + optional LLM review
  8. **Checkpoint**: git commit if changes made
- Each stage MUST complete before next starts
- File: refactor `crew-cli/src/pipeline/unified.ts`

### 5b. Token compaction (TODO)
- Track context usage per conversation
- At 75% of model's context window: auto-summarize middle messages
- Keep first 2 + last 6 messages intact
- Already exists at `crew-cli/src/context/token-compaction.ts` — verify it's active
- Critical for long multi-turn worker sessions

---

## Reference Material

- Claude Code TS source: `/tmp/claude-src/src/` (1,884 files, 33MB)
  - Tool system: `src/Tool.ts`, `src/tools/`
  - Context: `src/context.ts`
  - Coordinator: `src/coordinator/`
  - Bootstrap: `src/bootstrap/`
  - Main: `src/main.tsx` (803KB)
- Python rewrite: `https://github.com/instructkr/claw-code`
- Architecture analysis: saved in memory `project_crew_cli_overhaul.md`

---

## Quick Wins (can do in 30 min each)
1. Trust-gated tool filtering (Phase 1b) — highest impact per effort
2. Deterministic QA gate (Phase 4b) — stops false "approved" results
3. ProjectContext injection (Phase 2a) — stops wrong-tech-stack errors

## Commands to test after each change
```bash
# Rebuild
cd crew-cli && npm run build

# Test single execution (should read files, use replace, not overwrite)
NODE_DISABLE_COMPILE_CACHE=1 node bin/crew.js chat "add a hello world section to index.html" --apply --project /Users/jeffhobbs/Chuck

# Verify tools used
cat /Users/jeffhobbs/Chuck/.crew/pipeline-runs/pipeline-*.jsonl | python3 -c "import sys,json; [print(json.loads(l).get('phase',''),json.loads(l).get('executionResults',{}).get('results',[{}])[0].get('toolsUsed',[])) for l in sys.stdin if 'validate' in json.loads(l).get('phase','')]"

# Check no file overwrites
cd /Users/jeffhobbs/Chuck && git diff --stat
```
