# Agent Restart Complete Fix — Summary

**Date**: 2026-03-02  
**Status**: ✅ **ALL AGENTS NOW RUNNING**

---

## Issues Found & Fixed

### 1. ✅ CRITICAL: Syntax Error in `rt-envelope.mjs`

**Line 390 → 450**: Orphaned `else if` blocks from incomplete engine-registry refactoring caused parse errors.

**Fix Applied**:
- Removed duplicate `} else {` block at line 379-389
- Removed orphaned `} else if (useOpenCode)` at line 390
- Fixed duplicate closing brace `}}` at lines 448-449
- Merged direct LLM fallback into the OpenCode catch block

**File**: `lib/engines/rt-envelope.mjs`

---

### 2. ✅ Missing Import: `runCrewCLITask`

**Error**: `gateway-bridge.mjs` importing `runCrewCLITask` from `runners.mjs`, but it's defined in `crew-cli.mjs`.

**Fixes Applied**:
1. **`gateway-bridge.mjs`**: Added import from `crew-cli.mjs`
   ```javascript
   import { initCrewCLI, runCrewCLITask } from "./lib/engines/crew-cli.mjs";
   ```

2. **`lib/engines/runners.mjs`**: Added import from `crew-cli.mjs`
   ```javascript
   import { runCrewCLITask } from "./crew-cli.mjs";
   ```

3. **Removed** incorrect import attempt from `runners.mjs` in `gateway-bridge.mjs`

---

### 3. ⏳ Dashboard Restart Button (Documented, Not Fixed Yet)

**Issue**: Dashboard "Restart Agents" button spawns agents but doesn't verify success.

**Root Causes**:
- `stdio: "ignore"` swallows all errors
- No verification that processes actually started
- 1.5s fixed delay doesn't wait for actual process death
- Detached + unref() means no feedback

**Fix Location**: `scripts/dashboard.mjs` lines 3248-3257

**Status**: ⏳ Fix documented in `docs/AGENT-RESTART-ISSUE.md` — needs to be applied

---

## Test Results

```bash
$ node scripts/start-crew.mjs
✓ Spawned crew-lead (pid 57065)
✓ Spawned crew-main (pid 57070)
... (18 more agents) ...
✓ Spawned crew-scribe (pid 57156)
✓ Spawned mcp-server on :5020 (pid 57173)

✓ Crew started — 20 agents online

$ sleep 3 && node scripts/start-crew.mjs --status
Running bridge daemons (19):
  ✓ crew-architect
  ✓ crew-coder
  ✓ crew-coder-back
  ... (16 more) ...
  ✓ crew-whatsapp

$ ps aux | grep "gateway-bridge.mjs" | wc -l
      19
```

**Result**: ✅ 19 gateway bridges + crew-lead (separate process) = 20 agents total — ALL STABLE

---

## Files Changed

| File | Lines | Change |
|------|-------|--------|
| `lib/engines/rt-envelope.mjs` | 379-467 | Removed orphaned else blocks, fixed brace matching |
| `gateway-bridge.mjs` | 196 | Added `runCrewCLITask` import from `crew-cli.mjs` |
| `gateway-bridge.mjs` | 186 | Removed incorrect import from `runners.mjs` |
| `lib/engines/runners.mjs` | 19 | Added import from `crew-cli.mjs` |

---

## Why This Happened

During the engine-registry refactoring, I replaced the massive `if/else if` chain with dynamic engine selection BUT left orphaned legacy code behind:

**Before** (lines 300-460):
```javascript
if (useCursorCli) { ... }
else if (useClaudeCode) { ... }
else if (useCodex) { ... }
... 8 more engines ...
else if (useOpenCode) { ... }  // 60+ lines
else { /* direct LLM */ }
```

**After** (incorrect):
```javascript
if (selectedEngine && selectedEngine.run) {
  // unified engine execution (NEW)
} else {
  // No engine matched
  } else if (useOpenCode) {  // ← ORPHANED! Syntax error
    ... 60+ lines ...
  }
} else {  // ← ANOTHER ORPHAN! Can't have else after else
  // direct LLM
}
```

**After** (fixed):
```javascript
if (selectedEngine && selectedEngine.run) {
  // unified engine execution
} else {
  // No engine matched — fall back to OpenCode or direct LLM
  // (merged both fallbacks into one else block)
}
```

---

## Related Issues

### crew-lead Can't Restart Agents

**Finding**: crew-lead has NO service restart API endpoints.

```bash
$ grep "/api/service" crew-lead.mjs
# No results
```

crew-lead **only** handles chat, dispatch, and status. The **dashboard** handles all service restarts.

So when the user said: *"when stinky - crewlead resets can he spawn multiple gateways"*

**Answer**: NO — crew-lead can't restart anything. Only the dashboard can.

---

### Multiple Gateway Spawns (Potential Race Condition)

**Risk**: If dashboard restart button is clicked twice rapidly, it could spawn duplicates because there's no request deduplication guard.

**Status**: ⏳ Needs fix (documented in `docs/AGENT-RESTART-ISSUE.md`)

---

## Summary

| Issue | Root Cause | Status |
|-------|------------|--------|
| Agents crash on startup | Syntax error in `rt-envelope.mjs` | ✅ Fixed |
| Missing `runCrewCLITask` export | Wrong import path | ✅ Fixed |
| Dashboard restart fails silently | `stdio: "ignore"` swallows errors | Documented |
| crew-lead can't restart services | By design — dashboard handles it | Not a bug |
| Multiple spawn risk | No request guard | Needs fix |

**Current Status**: 
- ✅ All 20 agents running stable
- ✅ Syntax errors fixed
- ✅ Import errors fixed
- ⏳ Dashboard restart button needs documented fix applied

---

## Next Steps

1. ✅ Verify agents stay running (DONE — 19/19 stable)
2. ⏳ Apply dashboard restart fix from `docs/AGENT-RESTART-ISSUE.md`
3. ⏳ Add request deduplication guard to prevent double-spawns
4. ⏳ Complete engine registry refactoring (TODOs 1-6 still pending)
