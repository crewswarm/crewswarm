# PM Loop Auto-Start Prevention - Complete

**Date:** 2026-03-02  
**Issue:** 5 PM loops started without user action  
**Status:** ✅ FIXED

---

## What Was Auto-Starting PM Loops

### 1. ✅ LaunchAgent (Disabled)
**File:** `~/Library/LaunchAgents/com.crewswarm.stack.plist`
**What it did:** Ran `restart-all-from-repo.sh` at boot
**Status:** `launchctl unload` executed - DISABLED

### 2. ✅ Dashboard "Start PM Loop" Button
**Issue:** Multiple clicks spawned multiple instances
**Fix:** Added kill-existing-before-start logic
**Location:** `scripts/dashboard.mjs` line 878

### 3. ✅ Restart Script
**Issue:** Did NOT kill PM loops on restart
**Fix:** Added `pkill -9 -f "pm-loop.mjs"` to restart script
**Location:** `scripts/restart-all-from-repo.sh` line 26

---

## Fixes Applied

### Fix 1: Dashboard API - Kill Before Start
```javascript
// scripts/dashboard.mjs line 891
// Before spawning new PM loop, kill ALL existing instances
const running = execSync('ps aux | grep "pm-loop.mjs" | grep -v grep').toString();
if (running.trim()) {
  execSync('pkill -9 -f "pm-loop.mjs"');
  await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s
}
```

**Result:** Impossible to spawn duplicates from dashboard

### Fix 2: Restart Script - Always Kill PM Loops
```bash
# scripts/restart-all-from-repo.sh line 26
pkill -9 -f "pm-loop.mjs" 2>/dev/null; true  # NEVER auto-start PM loop
```

**Result:** PM loop never survives a restart

### Fix 3: LaunchAgent Disabled
```bash
launchctl unload ~/Library/LaunchAgents/com.crewswarm.stack.plist
```

**Result:** No auto-start at boot

---

## How PM Loop Starts Now (Manual Only)

### Option 1: Dashboard UI
1. Services tab → PM Loop section
2. Click "Start PM Loop" button
3. **Kills existing instances first** (new safeguard)
4. Spawns ONE new instance

### Option 2: Command Line
```bash
node pm-loop.mjs --project-dir /path/to/project
```

### Option 3: Never (Auto-Start Disabled)
- ❌ Boot (launchd disabled)
- ❌ Restart script (pm-loop explicitly killed)
- ❌ Multiple dashboard clicks (kills existing first)

---

## Verification

```bash
# Check nothing is running
ps aux | grep pm-loop | grep -v grep

# Should return: (empty)

# Check launchd
launchctl list | grep crewswarm

# Should NOT show com.crewswarm.stack running

# Start PM loop manually
node pm-loop.mjs --dry-run

# Verify ONE instance
ps aux | grep pm-loop | grep -v grep | wc -l
# Should return: 1
```

---

## Root Cause of 5 Instances

**Most likely:** Dashboard button clicked multiple times
- Before fix: Each click spawned new process
- PID check had race condition (PID file not written fast enough)
- Result: 5 instances all competing for same ROADMAP.md

**Possibly:** LaunchAgent restarting processes
- com.crewswarm.stack.plist was loaded but showing exit code 126
- May have tried to start stack multiple times

---

## Future: Add to Dashboard UI

**Recommended improvement:**
```javascript
// Disable button for 3 seconds after click
startButton.onclick = async () => {
  startButton.disabled = true;
  startButton.textContent = 'Starting...';
  
  await fetch('/api/pm-loop/start', { method: 'POST' });
  
  setTimeout(() => {
    startButton.disabled = false;
    startButton.textContent = 'Start PM Loop';
  }, 3000);
};
```

---

## Summary

**Before:**
- LaunchAgent could auto-start
- Dashboard button could spawn duplicates
- Restart script didn't kill PM loops

**After:**
- ✅ LaunchAgent disabled
- ✅ Dashboard kills existing before start
- ✅ Restart script kills PM loops
- ✅ PM loop ONLY starts when manually triggered

**Test:** Reboot your machine. PM loop should NOT start automatically.
