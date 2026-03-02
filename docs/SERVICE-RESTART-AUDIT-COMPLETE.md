# All Service Restart Endpoints Audit — 2026-03-02

## Summary

**Total Services**: 9  
**Broken (race conditions)**: 2 (both dashboard)  
**Safe**: 7  

## Audit Results

### ✗ BROKEN: Dashboard Self-Restart

**Location**: `scripts/dashboard.mjs` lines 3261-3270 AND 3317-3326

**Pattern**:
```javascript
spawnProc("node", ["scripts/dashboard.mjs"], { detached: true, stdio: "ignore" }).unref();
process.exit(0);
```

**Problem**: Spawns new process, then exits current process. Race window allows both to run simultaneously, fighting over port 4319.

**Fix Applied**: Return error message, force manual restart.

---

### ✓ SAFE: All Other Services

#### 1. RT Bus (line 3141)
```javascript
pkill -f "opencrew-rt-daemon"
wait 5 seconds for port 18889 to free
spawn new rt-daemon
```
✓ Safe: Waits for port to be completely free before spawning

#### 2. Agents (line 3162)
```javascript
pkill -f "gateway-bridge.mjs --rt-daemon"
wait 1.5 seconds
spawn start-crew.mjs (which spawns bridges)
```
✓ Safe: External script spawns bridges, not self-spawning

#### 3. Telegram (line 3172)
```javascript
kill PID from telegram-bridge.pid
wait 800ms
spawn telegram-bridge.mjs
```
✓ Safe: Uses PID file for precise kill, waits before spawn

#### 4. WhatsApp (line 3193)
```javascript
kill PID from whatsapp-bridge.pid
wait 800ms
spawn whatsapp-bridge.mjs
```
✓ Safe: Uses PID file for precise kill, waits before spawn

#### 5. crew-lead (line 3207)
```javascript
pkill -9 -f "crew-lead.mjs"
lsof -ti :5010 | xargs kill -9
wait up to 5 seconds for port to free
if port free AND no processes: spawn crew-lead.mjs
```
✓ Safe: Double-checks both process AND port before spawning

#### 6. MCP Server (line 3247)
```javascript
pkill -f "mcp-server.mjs"
lsof -ti :5020 | xargs kill -9
wait 800ms
spawn mcp-server.mjs
```
✓ Safe: Kills process AND port, waits before spawn

#### 7. OpenCode (line 3228)
```javascript
kill opencode process
spawn opencode serve (external binary)
```
✓ Safe: External binary, not self-spawning

#### 8. openclaw-gateway (line 3254)
```javascript
pkill -f "openclaw-gateway"
wait 1s
open -a OpenClaw (app auto-spawns gateway)
```
✓ Safe: External app manages gateway lifecycle

---

## Why Dashboard Was Broken

**Dashboard had TWO self-restart endpoints**:

1. **Restart endpoint** (line 3261): In `/api/services/restart` when `id === "dashboard"`
2. **Stop endpoint** (line 3317): In `/api/services/stop` when `id === "dashboard"` - DUPLICATE logic!

Both used the pattern:
```javascript
spawn new dashboard
wait 300ms
exit current dashboard
```

**The Race**:
1. New process starts
2. Old process hasn't exited yet
3. Both try to bind port 4319
4. One wins, one hangs or crashes
5. Singleton guard sees both, blocks new spawns
6. User sees "stopped", clicks restart again
7. **Infinite loop**

## The Fix

### Before
```javascript
} else if (id === "dashboard") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "Restarting dashboard..." }));
  await new Promise(r => setTimeout(r, 300));
  spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "dashboard.mjs")], {
    cwd: OPENCLAW_DIR, detached: true, stdio: "ignore",
  }).unref();
  process.exit(0);
  return;
}
```

### After
```javascript
} else if (id === "dashboard") {
  // Dashboard cannot restart itself - race condition between spawn and exit
  // Manual restart: pkill -9 -f dashboard.mjs && npm run dashboard
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ 
    ok: false, 
    message: "Dashboard cannot restart itself (prevents race condition). Manual restart: pkill -9 -f dashboard.mjs && npm run dashboard" 
  }));
  return;
}
```

Applied to **BOTH** the restart endpoint (line 3261) and stop endpoint (line 3317).

---

## Testing

### Verify Fix
```bash
# 1. Kill all dashboards
pkill -9 -f dashboard.mjs

# 2. Start fresh
npm run dashboard

# 3. Check single instance
ps aux | grep dashboard.mjs | grep -v grep | wc -l
# Should show: 1

# 4. Try restart via dashboard UI (should fail with error message)
# Expected: "Dashboard cannot restart itself (prevents race condition)..."

# 5. Manual restart
pkill -9 -f dashboard.mjs && npm run dashboard

# 6. Verify still single instance
ps aux | grep dashboard.mjs | grep -v grep | wc -l
# Should show: 1
```

### Load Test
```bash
# Spam restart button 10 times (used to spawn 10+ instances)
for i in {1..10}; do
  curl -s -X POST http://127.0.0.1:4319/api/services/restart \
    -H "Content-Type: application/json" \
    -d '{"id":"dashboard"}'
  echo "Attempt $i"
  sleep 0.5
done

# Check instance count (should still be 1)
ps aux | grep dashboard.mjs | grep -v grep | wc -l
```

---

## Files Changed

- `scripts/dashboard.mjs` (2 locations):
  - Line 3261-3270: Disabled dashboard restart in `/api/services/restart`
  - Line 3317-3326: Disabled dashboard stop/restart in `/api/services/stop`

---

## Status

✅ **FIXED** — Dashboard self-restart race condition eliminated  
✅ **AUDITED** — All 9 services checked, only dashboard was broken  
✅ **TESTED** — Single instance verified after fix  

**Date**: 2026-03-02 21:30:00  
**Root Cause**: Self-spawning before exit creates race window  
**Prevention**: Services must NEVER restart themselves - always use external restart
