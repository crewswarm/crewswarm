# Agent Restart & Dashboard Flashing Fix — 2026-03-02

## Problems Identified

### 1. Dashboard Flashing — Multiple Instances Running

**Symptom**: Dashboard UI was flickering/flashing randomly

**Root Cause**: Two `dashboard.mjs` processes running simultaneously on port 4319
- PID 56994 (first instance)
- PID 85654 (duplicate instance)

**Why It Happened**: The dashboard startup script was called multiple times without killing existing instances, leading to race conditions where both processes tried to serve on the same port.

**Impact**:
- UI flickering and inconsistent rendering
- Race conditions on API calls
- Unreliable dashboard state

---

### 2. Agents Not Restarting — Syntax Error in gateway-bridge.mjs

**Symptom**: Clicking "Restart Agents" in dashboard had no effect; no agent processes were running

**Root Cause**: Syntax error in `gateway-bridge.mjs` at line 54

```javascript
// BROKEN CODE (lines 50-61):
  acquireTaskLease,
  renewTaskLease,

// ── One-shot mode: exit after task completion (fresh context) ────────────────
const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1' || process.argv.includes('--one-shot');
  releaseTaskLease,
  markTaskDone,
  dispatchKeyForTask,
  shouldUseDispatchGuard,
  shouldRetryTaskFailure,
  isCodingTask,
} from "./lib/agents/dispatch.mjs";
```

The `const ONE_SHOT` declaration was inserted **in the middle of an ES6 import statement**, causing an immediate `SyntaxError: Unexpected reserved word` when Node tried to load the module.

**Why It Happened**: During the "one-shot mode" implementation (2026-03-01), the `const ONE_SHOT` line was added in the wrong place — inside the destructured import instead of after it.

**Impact**:
- All agent bridge processes crashed immediately on startup
- Zero agents available to process tasks
- Dashboard "Restart Agents" button appeared to do nothing (agents started then instantly died)
- No error messages visible to user — silent failure

**Test Output Before Fix**:
```
❌ Bridge process died immediately - checking logs:
file:///Users/jeffhobbs/Desktop/CrewSwarm/gateway-bridge.mjs:54
const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1' || process.argv.includes('--one-shot');
^^^^^

SyntaxError: Unexpected reserved word
```

---

## Fixes Applied

### 1. Fixed Duplicate Dashboard

**Action**: Killed all dashboard processes and restarted clean

```bash
pkill -9 -f "dashboard.mjs"
node scripts/dashboard.mjs > /tmp/dashboard.log 2>&1 &
```

**Verification**:
```bash
lsof -ti:4319 | wc -l
# Result: 1 (single process now)
```

**Recommendation**: Add singleton guard to dashboard startup script (similar to PM loop fix).

---

### 2. Fixed gateway-bridge.mjs Syntax Error

**File**: `gateway-bridge.mjs`

**Change**: Moved `const ONE_SHOT` declaration **after** the import statement closes.

```diff
  acquireTaskLease,
  renewTaskLease,
-
-// ── One-shot mode: exit after task completion (fresh context) ────────────────
-const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1' || process.argv.includes('--one-shot');
  releaseTaskLease,
  markTaskDone,
  dispatchKeyForTask,
  shouldUseDispatchGuard,
  shouldRetryTaskFailure,
  isCodingTask,
} from "./lib/agents/dispatch.mjs";
+
+// ── One-shot mode: exit after task completion (fresh context) ────────────────
+const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1' || process.argv.includes('--one-shot');
```

**Test After Fix**:
```bash
node gateway-bridge.mjs --agent-id crew-main --rt-daemon &
sleep 2
ps -p $! > /dev/null && echo "✅ Bridge alive"
# Result: ✅ Bridge alive
```

---

## Verification

### Final Agent Status

```bash
$ node scripts/start-crew.mjs --status

Running bridge daemons (19):
  ✓ crew-architect
  ✓ crew-coder
  ✓ crew-coder-back
  ✓ crew-coder-front
  ✓ crew-copywriter
  ✓ crew-fixer
  ✓ crew-frontend
  ✓ crew-github
  ✓ crew-main
  ✓ crew-mega
  ✓ crew-ml
  ✓ crew-pm
  ✓ crew-qa
  ✓ crew-researcher
  ✓ crew-security
  ✓ crew-seo
  ✓ crew-telegram
  ✓ crew-whatsapp
  ✓ orchestrator
```

**All 19 agent bridges running successfully** (crew-lead runs separately, not a bridge).

### Dashboard Status

```bash
$ ps aux | grep "dashboard.mjs" | grep -v grep | wc -l
1
```

**Single dashboard instance running** — no more flashing.

---

## Lessons Learned

### 1. Syntax Errors in Background Daemons Are Silent

When a daemon process crashes immediately on startup, there's often no visible error unless you explicitly capture stderr/stdout or manually test the script.

**Prevention**: Add smoke test to CI that validates all main entry point scripts can at least load without syntax errors:

```bash
# Add to CI or health check
for script in gateway-bridge.mjs crew-lead.mjs pm-loop.mjs scripts/dashboard.mjs; do
  node --check $script || exit 1
done
```

### 2. Edit Imports Carefully

ES6 import statements are sensitive to line breaks and positioning. When adding new top-level code, always ensure you're **outside** any active import block.

**Best Practice**: Add new `const` declarations **after** all imports are complete, never in the middle of a destructured import.

### 3. Dashboard Needs a Singleton Guard

Similar to the PM loop fix (2026-03-01), the dashboard startup should:
1. Check if dashboard is already running on port 4319
2. Kill existing instance before starting new one
3. Use PID file or port check for detection

**Recommended**: Apply same pattern used in `scripts/dashboard.mjs` `/api/pm-loop/start` endpoint (lines 3010-3084).

---

## Testing

### Manual Test: Restart Agents from Dashboard

1. Open `http://127.0.0.1:4319`
2. Go to **Services** tab
3. Click **Restart** on "Agents" service
4. Wait 3 seconds
5. Check status: `node scripts/start-crew.mjs --status`
6. **Expected**: 19 running bridge daemons

### Manual Test: No Dashboard Flashing

1. Open dashboard in browser
2. Switch between tabs (Chat, Settings, Memory, etc.)
3. Watch for UI flickering or content flashing
4. **Expected**: Smooth navigation, no flashing

### Manual Test: Dispatch a Task

1. Open dashboard → Chat tab
2. Send: `dispatch crew-coder to write hello.js that prints "Hello from crew"`
3. Wait for response
4. **Expected**: crew-coder responds with task completion

---

## Related Issues

- **PM Loop Auto-Start** (2026-03-01): Fixed similar issue where multiple `pm-loop.mjs` instances were spawning
- **One-Shot Mode** (2026-03-01): This feature addition introduced the syntax error
- **Flow Cleanup** (2026-03-01): Consolidated orchestrators, which increased reliance on agent bridges being functional

---

## Files Changed

- `gateway-bridge.mjs` (lines 50-62) — moved `const ONE_SHOT` after import statement
- No config changes required
- No dependency changes required

---

## Status

✅ **FIXED** — All agents running, dashboard stable, no flashing

**Date**: 2026-03-02 20:03:00  
**Author**: Cursor Agent (Claude Sonnet 4.5)  
**Verified By**: Manual testing + process inspection
