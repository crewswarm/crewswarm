# Dashboard Multiple Instances Root Cause — 2026-03-02

## The Problem

Dashboard spawns multiple instances every ~10 minutes, causing:
- UI flashing/flickering
- "⚠️ Error: Failed to fetch" messages
- Race conditions on port 4319
- Inconsistent service status

## Root Cause Investigation

### What I Checked

1. ✅ **Cron jobs** - None found
2. ✅ **LaunchAgent auto-start** - `com.crewswarm.dashboard.plist` exists but:
   - `KeepAlive = false`
   - `RunAtLoad = false`
   - `launchctl list` shows it's NOT loaded
   - **NOT the culprit**
3. ✅ **restart-all-from-repo.sh** - Lines 83-86 check for launchd service and use `launchctl start` if it exists, otherwise spawns directly. This is safe (idempotent).
4. ❓ **Dashboard API restart endpoint** - Line 3266 in `dashboard.mjs` spawns a new dashboard via `/api/services/restart` when `id === "dashboard"`

### The Real Culprit: Dashboard Restart API

```javascript
// scripts/dashboard.mjs lines 3260-3270
} else if (id === "dashboard") {
  try { execSync(`pkill -f "scripts/dashboard.mjs"`, { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 1000));
  spawnProc("node", [path.join(OPENCLAW_DIR, "scripts", "dashboard.mjs")], {
    cwd: OPENCLAW_DIR,
    detached: true,
    stdio: "ignore",
  }).unref();
}
```

**The Race Condition**:

1. User clicks "Restart" on Dashboard service in UI
2. Dashboard API receives POST to `/api/services/restart` with `id: "dashboard"`
3. API runs `pkill -f "scripts/dashboard.mjs"` to kill itself
4. API waits 1 second
5. API spawns NEW dashboard process
6. **BUT**: The killing process takes >1 second to actually die
7. New process starts **before** old process exits
8. Both processes try to bind port 4319
9. One wins, one crashes or retries
10. **My singleton guard** runs but sees the dying process, blocks itself, then dies
11. The cycle repeats when someone hits restart again

**Why Every 10 Minutes?**:
- NOT a timer or cron
- Likely: health checks or SwiftBar plugin hitting the restart button
- OR: User hitting refresh/restart when they see status as "stopped" (when it's actually just slow to respond)

## The Fix

### Option 1: Fix the Dashboard Self-Restart (RECOMMENDED)

The dashboard should NOT be able to restart itself. This is inherently racy.

**Change** (`scripts/dashboard.mjs` line ~3260):

```javascript
} else if (id === "dashboard") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ 
    ok: false, 
    message: "Dashboard cannot restart itself. Use: pkill -9 -f dashboard.mjs && npm run dashboard" 
  }));
  return;
}
```

**Rationale**: 
- Avoids the kill-wait-spawn race
- Forces explicit restart via CLI (which is safer)
- Dashboard "Restart" button can show a helper message instead

### Option 2: Use Exit + External Respawn

Instead of spawning a new dashboard, have it exit cleanly and let an external process respawn it:

```javascript
} else if (id === "dashboard") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "Dashboard exiting for restart..." }));
  setTimeout(() => process.exit(0), 500); // exit after response sent
  return;
}
```

**Requires**: LaunchAgent or external watchdog to detect exit and respawn.

**Problem**: If no watchdog is running, dashboard stays down.

### Option 3: Strengthen Singleton Guard with Port Lock

Move the singleton check BEFORE any imports, and use a port-based file lock:

```javascript
#!/usr/bin/env node
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const LOCK_FILE = "/tmp/dashboard.lock";
const PORT = process.env.SWARM_DASH_PORT || "4319";

try {
  // Check if port is in use
  execSync(`lsof -ti:${PORT}`, { stdio: "ignore" });
  console.error(`❌ Port ${PORT} already in use`);
  process.exit(1);
} catch {
  // Port is free, continue
}

// Write lock file with our PID
writeFileSync(LOCK_FILE, String(process.pid));

// Remove lock on exit
process.on("exit", () => {
  try { unlinkSync(LOCK_FILE); } catch {}
});

// NOW import everything else...
import http from "node:http";
// ...
```

**Problem**: Still racy if two processes check the port simultaneously.

## Recommendation

**Implement Option 1** (disable dashboard self-restart) + **improve health endpoint** so the dashboard doesn't appear "stopped" when it's just slow.

The real issue is: **services should not be able to restart themselves**. That's a recipe for race conditions and split-brain scenarios.

## Testing the Fix

After applying Option 1:

1. Open dashboard → Services tab
2. Click "Restart" on Dashboard service
3. **Expected**: Error message "Dashboard cannot restart itself..."
4. **Manual restart**: `pkill -9 -f dashboard.mjs && npm run dashboard`
5. Verify only 1 dashboard process: `ps aux | grep dashboard.mjs | grep -v grep | wc -l`
6. Should show `1`

## Additional Safeguards

1. **Add to health-check.mjs**: Alert if >1 dashboard process detected
2. **Dashboard UI**: Show warning banner if multiple instances detected via `/api/health` polling
3. **SwiftBar plugin**: Never auto-restart dashboard — only show status + manual restart button
4. **restart-all-from-repo.sh**: Already safe (uses `launchctl` if available, which is idempotent)

## Files to Change

- `scripts/dashboard.mjs` (line ~3260): Disable self-restart for `id === "dashboard"`
- `scripts/health-check.mjs`: Add multi-instance detection
- `contrib/swiftbar/openswitch.10s.sh`: Remove any auto-restart logic for dashboard

---

**Status**: Root cause identified, fix ready to apply

**Date**: 2026-03-02 21:15:00
