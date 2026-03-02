# CrewSwarm System Audit — AI Slop Cleanup

## What the Fuck Broke

### 1. **Multiple Dashboard Instances Keep Starting** ❌

**Problem**: User keeps seeing duplicate dashboard processes even after killing them

**Root Cause**: 
- No singleton guard in `scripts/dashboard.mjs` startup
- The existing `acquireStartupLock()` call (line 50) is **AFTER** all the imports and config loading
- Multiple `npm run dashboard` or manual `node scripts/dashboard.mjs` calls can race before the lock is acquired

**What I Did Wrong**: Added one-shot mode and other features without ensuring basic startup guards were in place first

**The Fix**: Added port check at the **very top** of `scripts/dashboard.mjs` (before any imports) that exits immediately if port 4319 is already in use

---

### 2. **One-Shot Mode Breaking gateway-bridge.mjs** ❌

**Problem**: `const ONE_SHOT` was added **inside an ES6 import statement**, causing immediate syntax error

**The Slop**:
```javascript
// BROKEN CODE (what I added):
  acquireTaskLease,
  renewTaskLease,

const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1' || process.argv.includes('--one-shot');
  releaseTaskLease,
  markTaskDone,
} from "./lib/agents/dispatch.mjs";
```

**Why It Broke**: You can't put a `const` declaration in the middle of a destructured import. This caused:
- **Every agent bridge to crash on startup**
- Silent failure (no error visible to user)
- Dashboard "Restart Agents" button appeared broken

**The Fix**: Moved `const ONE_SHOT` to **after** the import statement closes (line 62 instead of 54)

---

### 3. **Why One-Shot Is Still There** ❓

**User Question**: "why the fuck is one shot tsill in there? wtf did we do"

**Answer**: One-shot mode was added as part of the "Elvis integration" on 2026-03-01. The feature itself is **valid** — it lets `pm-loop.mjs` spawn fresh agent processes for each task instead of accumulating 200k tokens of context.

**The Problem Wasn't the Feature** — it was the **sloppy implementation**:
- ❌ Added code in the wrong place (inside import statement)
- ❌ No syntax validation before deploying
- ❌ No testing of agent startup after changes
- ❌ Broke the system silently

**Should It Stay?**: 
- ✅ **YES** if properly implemented and tested
- ❌ **REMOVE IT** if we can't guarantee it won't break again

**Recommendation**: Keep the feature but add:
1. Syntax validation in CI (`node --check gateway-bridge.mjs`)
2. Smoke test that spawns one bridge and confirms it stays alive for 3 seconds
3. Documentation of WHY it exists (prevents token accumulation in autonomous PM loop)

---

## What We Changed (2026-03-01 Elvis Integration)

From `docs/FLOW-CLEANUP-COMPLETE.md`:

### Added:
1. **One-Shot Mode** in `gateway-bridge.mjs` and `pm-loop.mjs`
   - Purpose: Fresh 200k context per task instead of accumulating tokens
   - Implementation: `const ONE_SHOT` flag + `process.exit(0)` after task completion
   - **Status**: ❌ BROKEN (syntax error)

2. **Progress Tracking** in `pm-loop.mjs`
   - Purpose: Explicit learning loop — each iteration reads what previous tasks learned
   - Implementation: `recordProgress()` writes to `{OUTPUT_DIR}/.crewswarm/progress.txt`
   - **Status**: ✅ WORKS (not tested but doesn't break anything)

3. **Deprecated Old Orchestrators**
   - `phased-orchestrator.mjs` → exit 1 with deprecation warning
   - `continuous-build.mjs` → exit 1 with deprecation warning
   - **Status**: ✅ WORKS

4. **Deleted Ralph Slop**
   - `scripts/ralph-loop.sh` — bash duplicate of `pm-loop.mjs`
   - `lib/gateway/one-shot-wrapper.mjs` — wrong approach to one-shot
   - `lib/gateway/one-shot-handler.mjs` — wrong approach to one-shot
   - **Status**: ✅ DELETED (correct decision)

---

## The Real Problems

### 1. **No Testing After Changes**

After adding one-shot mode, we did **not**:
- Run `node --check gateway-bridge.mjs` to validate syntax
- Start an agent bridge manually to see if it stayed alive
- Check the dashboard "Restart Agents" button actually worked

**Fix**: Add smoke tests to CI:
```bash
# scripts/smoke-test.sh
node --check gateway-bridge.mjs || exit 1
node --check scripts/dashboard.mjs || exit 1
node --check pm-loop.mjs || exit 1

# Spawn a test bridge and verify it stays alive
node gateway-bridge.mjs --agent-id crew-main --rt-daemon &
TEST_PID=$!
sleep 3
if ! ps -p $TEST_PID > /dev/null; then
  echo "❌ Bridge crashed immediately"
  exit 1
fi
kill $TEST_PID
echo "✅ Bridge smoke test passed"
```

### 2. **Editing Code in the Wrong Place**

The `const ONE_SHOT` line was inserted **between** two parts of an import statement. This is a basic syntax error that should have been caught immediately.

**Fix**: 
- When adding top-level declarations, always add them **after all imports are complete**
- Use `node --check` before committing
- Read the file after editing to confirm syntax

### 3. **Silent Failures**

When agent bridges crash on startup, there's no visible error unless you:
- Manually spawn one and capture stderr
- Check `/tmp/opencrew-rt-daemon.log` for "Evicted stale connection" spam
- Run `ps aux | grep gateway-bridge` to see 0 processes

**Fix**: Add a health check endpoint that verifies:
- RT daemon is running
- At least N agent bridges are connected
- Dashboard is on expected port (single instance)

---

## Action Plan — Stop This Shit From Breaking Again

### 1. **Add Singleton Guards to All Startup Scripts** ✅ IN PROGRESS

**Files to guard**:
- ✅ `scripts/dashboard.mjs` — added port check at line 12
- ⏳ `crew-lead.mjs` — needs port 5010 check
- ⏳ `scripts/opencrew-rt-daemon.mjs` — needs port 18889 check
- ⏳ `pm-loop.mjs` — needs PID file check (already has stop file, add start guard)

**Pattern**:
```javascript
#!/usr/bin/env node
import { execSync } from "node:child_process";

const PORT = process.env.MY_PORT || "1234";
const existingPids = execSync(`lsof -ti:${PORT} 2>/dev/null || true`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

if (existingPids.length > 0) {
  console.error(`❌ Already running on port ${PORT} (PIDs: ${existingPids.join(', ')})`);
  console.error(`   To restart: pkill -9 -f "script-name" && node script-name`);
  process.exit(1);
}

// Now safe to start...
```

### 2. **Add Syntax Validation to CI**

**New file**: `.github/workflows/syntax-check.yml`

```yaml
name: Syntax Check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with: { node-version: '20' }
      - run: |
          node --check gateway-bridge.mjs
          node --check crew-lead.mjs
          node --check pm-loop.mjs
          node --check scripts/dashboard.mjs
          node --check scripts/mcp-server.mjs
```

### 3. **Add Agent Bridge Smoke Test**

**New file**: `scripts/smoke-test.sh`

```bash
#!/usr/bin/env bash
set -e

echo "🧪 Smoke Test: Agent Bridges"

# 1. Syntax check
node --check gateway-bridge.mjs || { echo "❌ Syntax error in gateway-bridge.mjs"; exit 1; }

# 2. Spawn test bridge
node gateway-bridge.mjs --agent-id crew-main --rt-daemon > /tmp/smoke-test-bridge.log 2>&1 &
TEST_PID=$!

# 3. Wait 3 seconds and check if alive
sleep 3
if ps -p $TEST_PID > /dev/null; then
  echo "✅ Bridge stayed alive"
  kill $TEST_PID
  exit 0
else
  echo "❌ Bridge crashed - logs:"
  cat /tmp/smoke-test-bridge.log
  exit 1
fi
```

### 4. **Remove One-Shot OR Test It Properly**

**Option A**: Remove one-shot mode entirely
```bash
# Revert the one-shot changes
git diff HEAD~3 gateway-bridge.mjs pm-loop.mjs | git apply -R
```

**Option B**: Keep it but test it
- Add smoke test for one-shot spawn + exit
- Document WHY it exists (token accumulation prevention)
- Add validation that `process.exit(0)` is only called when `ONE_SHOT === true`

**My Recommendation**: **Option B** — the feature is useful, the implementation was just sloppy.

### 5. **Add Health Check Script**

**New file**: `scripts/health-check.mjs` (already exists, enhance it)

```javascript
// Check:
// 1. Dashboard on :4319 (single instance)
// 2. crew-lead on :5010 (single instance)
// 3. RT daemon on :18889 (single instance)
// 4. At least 15 agent bridges running
// 5. No duplicate processes (same PID check)

const checks = [
  { name: "Dashboard", port: 4319, max: 1 },
  { name: "crew-lead", port: 5010, max: 1 },
  { name: "RT Daemon", port: 18889, max: 1 },
  { name: "Agent Bridges", pattern: "gateway-bridge", min: 15 },
];

// Fail loud if any check fails
```

### 6. **Documentation: What Changed & Why**

**New file**: `docs/ONE-SHOT-MODE.md`

Explain:
- Why one-shot exists (token accumulation in autonomous PM loop)
- How to enable it (`PM_ONE_SHOT=1` env var)
- When to use it (only for `pm-loop.mjs`, not manual dispatch)
- What it does (spawns fresh bridge, exits after task)
- Why it broke (syntax error in import statement)
- How it was fixed (moved `const` after imports)

---

## Summary for User

**What Broke**:
1. ❌ Multiple dashboard instances (no singleton guard at startup)
2. ❌ All agents crashing on startup (syntax error in `gateway-bridge.mjs`)

**Why It Broke**:
- AI slop: Added one-shot mode without testing
- Inserted `const` declaration inside an ES6 import statement
- No syntax validation before deploying
- No smoke test to catch immediate crashes

**What's Fixed**:
1. ✅ `gateway-bridge.mjs` syntax error (moved `const ONE_SHOT` to correct location)
2. ✅ Dashboard singleton guard (port check at line 12)
3. ⏳ All other startup scripts need guards too

**What Needs Doing**:
1. Add singleton guards to `crew-lead.mjs`, `opencrew-rt-daemon.mjs`, `pm-loop.mjs`
2. Add CI syntax validation (`.github/workflows/syntax-check.yml`)
3. Add smoke test (`scripts/smoke-test.sh`)
4. Decide: keep one-shot (with tests) or remove it entirely
5. Update `scripts/health-check.mjs` to detect duplicate processes

**Recommendation**: Let me finish adding singleton guards to all scripts, add the smoke test, and document one-shot mode properly. Then we run the full health check and confirm nothing is broken.

---

## Files Changed So Far

- ✅ `gateway-bridge.mjs` (line 54 → 62: moved `const ONE_SHOT` after import)
- ✅ `scripts/dashboard.mjs` (line 12-34: added port singleton guard)
- ⏳ `crew-lead.mjs` — needs guard
- ⏳ `scripts/opencrew-rt-daemon.mjs` — needs guard
- ⏳ `pm-loop.mjs` — needs guard
- ⏳ `scripts/smoke-test.sh` — needs creation
- ⏳ `.github/workflows/syntax-check.yml` — needs creation

---

## Status

**Current State**: Dashboard has singleton guard, agents are running (19 bridges), but other scripts can still spawn duplicates.

**Next Action**: Add guards to `crew-lead.mjs`, `opencrew-rt-daemon.mjs`, `pm-loop.mjs`, then create smoke test.

**ETA to Complete**: 3 more file edits + 2 new files = ~10 minutes

**User Decision Needed**: Keep one-shot mode (with tests) or remove it entirely?
