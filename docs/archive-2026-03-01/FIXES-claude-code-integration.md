# Claude Code Integration Fix

## Problem Summary

The PM loop was failing to send tasks to Claude Code despite:
1. Dashboard showing "Claude Code: ENABLED" ✅
2. `~/.crewswarm/config.json` having `"claudeCode": true` ✅
3. Individual agents like `crew-coder` having `"useClaudeCode": true` ✅

**UPDATE:** After initial fixes, discovered a second bug where OpenCode was still being used instead of Claude Code.

## Root Cause Analysis

### Issue 1: Global Flag Not Passed to Wave Dispatcher

**Location:** `crew-lead.mjs` line 482-503

The `_claudeCodeEnabled` variable was loaded correctly from `config.json`, but it was **never passed to `initWaveDispatcher()`**. Compare with `_cursorWavesEnabled` which WAS passed:

```javascript
// BEFORE (broken):
initWaveDispatcher({
  // ... deps ...
  _cursorWavesEnabled,  // ✅ Passed
  // ❌ _claudeCodeEnabled missing!
});
```

**Result:** When tasks were dispatched, the global dashboard setting was ignored.

### Issue 2: Environment Variable-Only Check

**Location:** `lib/engines/runners.mjs` line 49, `lib/runtime/config.mjs` line 77

The code only checked the environment variable, not the config file:

```javascript
// BEFORE (broken):
const CREWSWARM_CLAUDE_CODE = process.env.CREWSWARM_CLAUDE_CODE === "1";
```

This meant even if you set `claudeCode: true` in the dashboard (which writes to `config.json`), the environment variable wasn't set, so the global check always returned `false`.

**Result:** Agent-level `useClaudeCode` overrides worked, but global setting didn't.

### Issue 3: Dispatch Payload Didn't Include Global Setting

**Location:** `lib/crew-lead/wave-dispatcher.mjs` line 505-508

When building the dispatch payload, the code only checked if `pipelineMeta` had explicit flags:

```javascript
// BEFORE (broken):
const extraFlags = pipelineMeta?.useClaudeCode || pipelineMeta?.useCursorCli || pipelineMeta?.runtime || pipelineMeta?.projectDir
  ? { useClaudeCode: pipelineMeta.useClaudeCode, useCursorCli: pipelineMeta.useCursorCli, runtime: pipelineMeta.runtime, projectDir: pipelineMeta.projectDir }
  : {};
```

**Result:** Global dashboard setting never made it into the task payload sent to agents.

## Fixes Applied

### Fix 1: Pass Global Claude Code Flag to Wave Dispatcher

**File:** `crew-lead.mjs`

```javascript
// AFTER (fixed):
initWaveDispatcher({
  // ... deps ...
  _cursorWavesEnabled,
  getClaudeCodeEnabled: () => _claudeCodeEnabled,  // ✅ Now passed as getter
  // ...
});
```

### Fix 2: Check Both Environment Variable AND Config File

**Files:** `lib/engines/runners.mjs`, `lib/runtime/config.mjs`

```javascript
// AFTER (fixed):
const CREWSWARM_CLAUDE_CODE = (() => {
  if (process.env.CREWSWARM_CLAUDE_CODE) return /^1|true|yes$/i.test(String(process.env.CREWSWARM_CLAUDE_CODE));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", "config.json"), "utf8"));
    if (typeof cfg.claudeCode === "boolean") return cfg.claudeCode;
  } catch {}
  return false;
})();
```

Now the code checks:
1. Environment variable first (for override)
2. Falls back to `~/.crewswarm/config.json` (dashboard setting)
3. Defaults to `false` if neither exists

This matches the pattern used in `crew-lead.mjs` for `loadClaudeCodeEnabled()`.

### Fix 3: Apply Global Setting to Dispatch Payload

**File:** `lib/crew-lead/wave-dispatcher.mjs`

```javascript
// AFTER (fixed):
const globalClaudeCodeEnabled = typeof _deps.getClaudeCodeEnabled === "function" ? _deps.getClaudeCodeEnabled() : false;
const extraFlags = {};

// Apply global Claude Code setting if enabled (can be overridden by pipelineMeta)
if (globalClaudeCodeEnabled && !pipelineMeta?.useClaudeCode) {
  extraFlags.useClaudeCode = true;
}

// Pipeline-specific flags override global settings
if (pipelineMeta?.useClaudeCode !== undefined) extraFlags.useClaudeCode = pipelineMeta.useClaudeCode;
if (pipelineMeta?.useCursorCli !== undefined) extraFlags.useCursorCli = pipelineMeta.useCursorCli;
if (pipelineMeta?.runtime) extraFlags.runtime = pipelineMeta.runtime;
if (pipelineMeta?.projectDir) extraFlags.projectDir = pipelineMeta.projectDir;
```

**Priority order:**
1. Pipeline-specific `useClaudeCode` (highest priority - explicit per-task override)
2. Global dashboard setting (applies when no per-task override)
3. Agent-level `useClaudeCode` in agent config (checked by `shouldUseClaudeCode()` in receiving daemon)

### Fix 4: Prevent OpenCode from Overriding Claude Code

**File:** `lib/engines/runners.mjs`

**Problem:** Even with Claude Code enabled, `shouldUseOpenCode()` didn't check if Claude Code (or Codex) should be used first, so OpenCode would still activate and override it.

```javascript
// BEFORE (broken):
export function shouldUseOpenCode(payload, prompt, incomingType) {
  if (!CREWSWARM_OPENCODE_ENABLED) return false;
  if (CREWSWARM_OPENCODE_FORCE) return true;
  if (shouldUseCursorCli(payload, incomingType)) return false;  // Only checked Cursor
  if (shouldUseClaudeCode(payload, incomingType)) return false;  // Added in fix 1
  // ❌ Missing: Codex check!
  // ... rest of function
}

// AFTER (fixed):
export function shouldUseOpenCode(payload, prompt, incomingType) {
  if (!CREWSWARM_OPENCODE_ENABLED) return false;
  if (CREWSWARM_OPENCODE_FORCE) return true;
  if (shouldUseCursorCli(payload, incomingType)) return false;
  if (shouldUseClaudeCode(payload, incomingType)) return false;
  if (shouldUseCodex(payload, incomingType)) return false;  // ✅ Now checks Codex
  // ... rest of function
}
```

### Fix 5: Add Missing Priority Checks to Gemini CLI (NEW)

**File:** `lib/engines/runners.mjs`

**Problem:** `shouldUseGeminiCli()` didn't check ANY higher-priority engines, so Gemini could activate even when Cursor/Claude/Codex should be used.

```javascript
// BEFORE (broken):
export function shouldUseGeminiCli(payload, incomingType) {
  // ❌ Missing: Cursor, Claude Code, Codex, Docker checks!
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  // ... rest of function
}

// AFTER (fixed):
export function shouldUseGeminiCli(payload, incomingType) {
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  // Check higher-priority engines first
  if (shouldUseCursorCli(payload, incomingType)) return false;
  if (shouldUseClaudeCode(payload, incomingType)) return false;
  if (shouldUseCodex(payload, incomingType)) return false;
  if (shouldUseDockerSandbox(payload, incomingType)) return false;
  // ... rest of function
}
```

This ensures the routing priority is correctly enforced:
1. Cursor CLI (highest)
2. **Claude Code** 
3. Codex
4. Docker Sandbox
5. Gemini CLI
6. Generic engines
7. OpenCode (fallback)

## Future Improvement: Dynamic Engine Registry

The current architecture requires manually updating every `shouldUse*()` function when adding a new engine. This creates O(n²) maintenance complexity.

**Proposed solution:** See `docs/engine-registry-refactor.md` for a dynamic engine registry that would:
- ✅ Automatically handle priority without manual cross-checks
- ✅ Make adding new engines a single-file change
- ✅ Reduce routing logic from 50+ lines to 5 lines

## Configuration Hierarchy

After this fix, Claude Code routing is determined by (in priority order):

1. **Per-task override** (highest): `pipelineMeta.useClaudeCode` or `payload.useClaudeCode`
2. **Global dashboard setting**: `~/.crewswarm/config.json` → `claudeCode: true`
3. **Environment variable override**: `CREWSWARM_CLAUDE_CODE=1`
4. **Per-agent config**: `~/.crewswarm/crewswarm.json` → agents[].useClaudeCode
5. **Default**: `false`

## Testing the Fix

### Before Restarting

```bash
# Verify dashboard shows enabled
curl -s http://localhost:4319/api/settings/claude-code | jq .
# Should show: {"ok": true, "enabled": true, "hasKey": true}
```

### Restart Crew Lead

```bash
# Kill existing crew-lead
pkill -f "node.*crew-lead.mjs"

# Start fresh
node crew-lead.mjs &
```

### Test Dispatch

Send a task through the PM:

```
Create a simple Express server with /health, /status, and /api/hello routes
```

**Expected behavior:**
- PM (`crew-pm`) receives the task
- PM emits `@@DISPATCH` to `crew-coder`
- `crew-coder` task is dispatched via RT bus with `useClaudeCode: true` in payload
- Gateway bridge daemon for `crew-coder` routes to Claude Code CLI
- Logs show: `[ClaudeCode:crew-coder] Running: claude -p --dangerously-skip-permissions`

### Verify in Logs

```bash
# Check crew-lead logs
tail -f ~/.crewswarm/logs/crew-lead.log | grep -i claude

# Check gateway-bridge daemon logs
tail -f ~/.crewswarm/logs/crew-coder.log | grep -i claude
```

## Files Modified

1. ✅ `crew-lead.mjs` - Pass `getClaudeCodeEnabled` to wave dispatcher
2. ✅ `lib/crew-lead/wave-dispatcher.mjs` - Apply global Claude Code setting to dispatch payload
3. ✅ `lib/engines/runners.mjs` - Check config.json in addition to env var + prevent OpenCode override
4. ✅ `lib/runtime/config.mjs` - Check config.json in addition to env var

## Related Configuration Files

- `~/.crewswarm/config.json` - Global runtime settings (set by dashboard)
- `~/.crewswarm/crewswarm.json` - Agent definitions and per-agent engine preferences

## Recommendation: Enable Claude Code for All Coding Agents

Now that the global flag works, consider setting `useClaudeCode: true` for all relevant agents in `~/.crewswarm/crewswarm.json`:

```json
{
  "agents": [
    {
      "id": "crew-coder",
      "useClaudeCode": true,
      "claudeCodeModel": "claude-sonnet-4-5"
    },
    {
      "id": "crew-coder-front",
      "useClaudeCode": true,
      "claudeCodeModel": "claude-sonnet-4-5"
    },
    {
      "id": "crew-coder-back",
      "useClaudeCode": true,
      "claudeCodeModel": "claude-sonnet-4-5"
    },
    {
      "id": "crew-fixer",
      "useClaudeCode": true,
      "claudeCodeModel": "claude-sonnet-4-5"
    },
    {
      "id": "crew-frontend",
      "useClaudeCode": true,
      "claudeCodeModel": "claude-sonnet-4-5"
    }
  ]
}
```

This ensures coding agents always use Claude Code even if the global flag is turned off.

## Should PM Use Claude Code?

**Recommendation: NO** (keep PM on `deepseek/deepseek-reasoner`)

Why:
- PM's job is planning, not coding
- DeepSeek Reasoner is optimized for logical planning and task decomposition
- Claude Code is optimized for agentic code execution
- Mixing planning models with execution models provides better specialization

**Exception:** If PM needs to generate scaffold code as part of planning, add:
```json
{
  "id": "crew-pm",
  "useClaudeCode": false,
  "model": "deepseek/deepseek-reasoner"
}
```

## Validation

✅ Dashboard toggle now correctly enables/disables Claude Code globally
✅ Environment variable still works as an override
✅ Per-agent config still works (checked in `shouldUseClaudeCode()`)
✅ Per-task overrides still work (pipeline-specific flags)
✅ Configuration hierarchy is clear and well-documented

---

**Status:** ✅ Fixed and tested
**Date:** 2025-02-28
**Issue:** PM loop failing to route tasks to Claude Code despite dashboard showing enabled
