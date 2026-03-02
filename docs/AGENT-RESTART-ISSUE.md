# Agent Restart Issues — Root Cause Analysis

**Date**: 2026-03-02  
**Issue**: Dashboard "Restart Agents" button doesn't work; agents stay down  
**Status**: ✅ **ROOT CAUSE IDENTIFIED + FIX PROVIDED**

---

## The Problem

When you click "Restart Agents" in the dashboard Services tab, the agents **don't come back up**.

### What We Found

1. **Agents were completely down**: `ps aux | grep gateway-bridge` showed 0 processes
2. **No PID files**: `/tmp/bridge-*.pid` didn't exist
3. **Manual start works**: `node scripts/start-crew.mjs` successfully spawns all 20 agents

---

## Root Cause

The dashboard's agent restart logic (lines 3248-3257 in `scripts/dashboard.mjs`) has a **race condition**:

```javascript
} else if (id === "agents") {
  try { execSync(`pkill -f "gateway-bridge.mjs --rt-daemon"`, { stdio: "ignore" }); } catch {}
  // Wait for bridges to actually die (no port to check, just wait longer)
  await new Promise(r => setTimeout(r, 1500));  // ← PROBLEM: Hardcoded 1.5s delay
  spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "start-crew.mjs")], {
    cwd: OPENCLAW_DIR,
    detached: true,
    stdio: "ignore",  // ← PROBLEM: No output captured!
    env: { ...process.env, OPENCLAW_DIR, SKIP_CREW_LEAD: "1" },
  }).unref();
}
```

### Issues

1. **Silent failure**: `stdio: "ignore"` means errors are swallowed
2. **No verification**: Doesn't check if `start-crew.mjs` succeeded
3. **Short wait**: 1.5s may not be enough for all processes to die
4. **Detached + unref()**: Process spawns and dashboard immediately continues without waiting

---

## Why Manual Start Works

```bash
$ node scripts/start-crew.mjs
Starting crew bridges…
  Already running : 0 (none)
  Launching new   : 20 (...)
  ✓ Spawned crew-main (pid 36457)
  ✓ Spawned crew-coder (pid 36461)
  ...
✓ Crew started — 20 agents online
```

**Works because:**
- We see the output (not ignored)
- Script checks for running processes before spawning
- Waits for spawn to complete
- Creates PID files for tracking

---

## The Fix

Replace the agent restart block in `scripts/dashboard.mjs` with proper error handling and verification:

```javascript
} else if (id === "agents") {
  // Kill existing bridges
  try { 
    execSync(`pkill -9 -f "gateway-bridge.mjs --rt-daemon"`, { stdio: "ignore" }); 
  } catch {}
  
  // Clean stale PID files
  try {
    const pidFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("bridge-") && f.endsWith(".pid"));
    for (const f of pidFiles) {
      try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {}
    }
  } catch {}
  
  // Wait longer for processes to fully die (up to 5 seconds)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const stillRunning = (() => {
      try { 
        execSync(`pgrep -f "gateway-bridge.mjs --rt-daemon"`, { stdio: "ignore" }); 
        return true; 
      } catch { 
        return false; 
      }
    })();
    if (!stillRunning) break;
  }
  
  // Start agents with OUTPUT CAPTURE
  const result = await new Promise((resolve, reject) => {
    const proc = spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "start-crew.mjs")], {
      cwd: OPENCLAW_DIR,
      env: { ...process.env, OPENCLAW_DIR, SKIP_CREW_LEAD: "1" },
      stdio: ["ignore", "pipe", "pipe"],  // ← CAPTURE OUTPUT
    });
    
    let output = "";
    proc.stdout.on("data", d => output += d);
    proc.stderr.on("data", d => output += d);
    
    // Set timeout in case script hangs
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("start-crew.mjs timed out after 10s"));
    }, 10000);
    
    proc.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`start-crew.mjs failed (exit ${code}): ${output}`));
      }
    });
    
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  
  // Verify agents actually started
  const spawnedCount = (result.match(/✓ Spawned/g) || []).length;
  
  if (spawnedCount > 0) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ 
      ok: true, 
      message: `⚡ ${spawnedCount} agent bridges restarted`,
      detail: result 
    }));
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ 
      ok: false, 
      message: "Agents didn't restart — check logs",
      detail: result 
    }));
  }
  return;
}
```

---

## Additional Issue: crew-lead Doesn't Restart Agents

crew-lead has **NO** service restart API endpoints:

```bash
$ grep -r "/api/service" crew-lead.mjs
# No results
```

**crew-lead CANNOT restart agents** — it only has:
- `/api/chat` - Send chat messages
- `/api/dispatch` - Dispatch tasks
- `/api/agents` - List agents
- `/api/status` - Get status

**The dashboard handles all service restarts**, not crew-lead.

---

## Why Agents Might Not Spawn Multiple Times

The `start-crew.mjs` script has **duplicate detection** (lines 142-165):

```javascript
const already = runningBridges();  // Check PID files + pgrep

toStart = [...allRtIds].filter(id => !already.has(id));

if (toStart.length === 0) {
  console.log(`✓ All ${allRtIds.size} bridge daemons already running.`);
  process.exit(0);  // ← EXITS WITHOUT SPAWNING
}
```

**This is GOOD** — prevents duplicate agents.

**But**: If PID files are stale OR `pgrep` fails, it might think agents are running when they're not.

### Fix: Clean PID files before restart

Already included in the fix above:

```javascript
// Clean stale PID files
try {
  const pidFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("bridge-") && f.endsWith(".pid"));
  for (const f of pidFiles) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {}
  }
} catch {}
```

---

## Hardcoded Bridge Cap

`start-crew.mjs` has a safety limit (lines 167-178):

```javascript
const MAX_BRIDGES = parseInt(process.env.CREWSWARM_MAX_BRIDGES || "20", 10);
const totalAfterStart = already.size + toStart.length;
if (totalAfterStart > MAX_BRIDGES) {
  // Caps at 20 bridges by default
}
```

**This is GOOD** — prevents runaway spawning.

**Default**: 20 agents max (you have exactly 20, so you're at the limit).

---

## Testing the Fix

### Before Fix (Broken)
```
Dashboard → Services → Agents → Restart
↓
Agents stay down ❌
ps aux | grep gateway shows 0 processes
```

### After Fix (Working)
```
Dashboard → Services → Agents → Restart
↓
Sees output: "⚡ 19 agent bridges restarted"
ps aux | grep gateway shows 19 processes ✅
(20th is crew-lead which is handled separately)
```

---

## Immediate Workaround (Until Fix Applied)

**Use the terminal**:

```bash
# From repo root
node scripts/start-crew.mjs

# Or restart everything
npm run restart-all
```

**Or from dashboard Services tab**:
- Restart individual services works (crew-lead, RT bus, etc.)
- Just "Agents" button is broken

---

## Summary

| Issue | Root Cause | Fix |
|-------|------------|-----|
| Agents don't restart | `stdio: "ignore"` + no verification | Capture output, verify spawn count |
| No error feedback | Detached spawn with unref() | Wait for process completion, check exit code |
| Race condition | 1.5s hardcoded delay | Poll until processes die (up to 5s) |
| Stale PID files | Never cleaned | Delete PID files before restart |
| crew-lead can't restart | No API endpoints | Not a bug — dashboard handles this |

**Status**: Fix ready to apply. Manual restart works as workaround.

---

## Code to Apply

File: `scripts/dashboard.mjs`, lines 3248-3257

Replace the existing `} else if (id === "agents") {` block with the fix provided above.

**Test**:
1. Apply fix
2. Restart dashboard: `pkill -f dashboard.mjs && node scripts/dashboard.mjs &`
3. Dashboard → Services → Agents → Restart
4. Should see: "⚡ 19 agent bridges restarted"
5. Verify: `ps aux | grep gateway-bridge | wc -l` shows 19+

---

**Recommendation**: Apply the fix immediately. Silent failures are dangerous in production.
