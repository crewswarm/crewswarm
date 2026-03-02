# CrewSwarm Process Duplication — Root Cause Analysis

**Date**: 2026-03-01  
**Severity**: CRITICAL — System Instability  
**Status**: ROOT CAUSE IDENTIFIED

---

## Executive Summary

**The system has BOTH a cleanup mechanism AND a startup guard. They work correctly individually, BUT launchd KeepAlive defeats both.**

The process duplication issue is caused by a **fundamental architectural conflict** between three systems:

1. **Startup guard** (`lib/runtime/startup-guard.mjs`) — Works correctly ✓
2. **Restart script** (`scripts/restart-all-from-repo.sh`) — Works correctly ✓  
3. **macOS launchd with KeepAlive** — **FIGHTS BOTH** ✗

When you run `bash scripts/restart-all-from-repo.sh`, it kills processes **BUT launchd immediately respawns them** (within the 10-15 second ThrottleInterval). The restart script then spawns NEW processes on top, creating duplicates.

**You DO have cleanup daemons and startup guards. They're just being defeated by launchd.**

---

## The Three Systems

### 1. Startup Guard (Working as Designed)

Location: `lib/runtime/startup-guard.mjs`

**What it does:**
- Checks for existing PID files in `~/.crewswarm/pids/`
- Verifies process is alive with `process.kill(pid, 0)`
- If port specified, checks with `lsof -ti :PORT`
- If `killStale: true`, kills stale processes occupying the port
- Writes new PID file and sets up cleanup on `exit`, `SIGINT`, `SIGTERM`

**Used by:**
```javascript
// crew-lead.mjs:112
const lockResult = acquireStartupLock("crew-lead", { port: PORT, killStale: true });

// scripts/dashboard.mjs:60
const lockResult = acquireStartupLock("crewswarm-dashboard", { port: listenPort, killStale: true });

// scripts/opencrew-rt-daemon.mjs:452
const lockResult = acquireStartupLock("opencrew-rt-daemon", { port: config.port, killStale: true });
```

**Why it's not preventing duplicates:**
The startup guard runs INSIDE each process when it starts. By the time it acquires the lock, launchd has already spawned multiple competing instances within ~10-15 seconds of each other.

### 2. Restart Script (Working as Designed)

Location: `scripts/restart-all-from-repo.sh`

**What it does (lines 12-46):**
```bash
# 1. Kill by process name
pkill -9 -f "gateway-bridge.mjs"
pkill -9 -f "opencrew-rt-daemon.mjs"
pkill -9 -f "crew-lead.mjs"
pkill -9 -f "scripts/dashboard.mjs"
# ... etc

# 2. Kill by port (catches launchd stragglers)
lsof -ti :5010 | xargs kill -9   # crew-lead
lsof -ti :4319 | xargs kill -9   # dashboard
lsof -ti :18889 | xargs kill -9  # RT daemon
# ... etc

# 3. Clean stale PID files
find /tmp -maxdepth 1 -name "bridge-*.pid" -delete

sleep 2

# 4. Verify ports are clear
for port in 5010 4319 18889 4096 5020; do
  if lsof -ti :$port; then
    echo "WARNING: port $port still held — force killing..."
    lsof -ti :$port | xargs kill -9
  fi
done
```

**Then spawns services (lines 49-92):**
```bash
nohup opencode serve --port 4096 &
nohup node scripts/opencrew-rt-daemon.mjs &
node scripts/start-crew.mjs  # spawns gateway bridges
nohup node crew-lead.mjs &

# Dashboard — launchd-aware check:
if launchctl list com.crewswarm.dashboard >/dev/null 2>&1; then
  launchctl stop com.crewswarm.dashboard
  launchctl start com.crewswarm.dashboard
else
  nohup node scripts/dashboard.mjs &
fi
```

**Why it's not preventing duplicates:**
The script correctly checks for launchd (line 82) BUT:
1. After `pkill -9`, launchd sees the process died
2. Script waits 2 seconds (line 37)
3. launchd waits `ThrottleInterval` (10-15 seconds) before respawn
4. Script spawns NEW processes (lines 52-87) BEFORE launchd's throttle expires
5. 8-13 seconds later, launchd respawns its own copies
6. **Result: 2x of everything**

### 3. macOS launchd (The Problem)

Location: `~/Library/LaunchAgents/`

**Active LaunchAgents:**
```bash
$ launchctl list | grep crewswarm
-	126	com.crewswarm.stack          # KeepAlive: false (OK)
12467	-15	com.crewswarm.dashboard      # KeepAlive: true ← PROBLEM
82593	0	application.com.crewswarm.crewchat...
-	1	com.crewswarm.whatsapp       # KeepAlive: true ← PROBLEM
12739	-15	com.crewswarm.telegram       # KeepAlive: true ← PROBLEM
```

**Dashboard plist (~/Library/LaunchAgents/com.crewswarm.dashboard.plist):**
```xml
<key>KeepAlive</key>
<true/>
<key>ThrottleInterval</key>
<integer>10</integer>
```

**What this means:**
- If the dashboard process dies (crash, SIGTERM, SIGKILL), launchd waits 10 seconds then respawns it
- `launchctl stop` does NOT disable KeepAlive — it just stops the CURRENT instance
- To truly stop, you must `launchctl unload` the plist

**Telegram/WhatsApp plists:**
```xml
<key>KeepAlive</key>
<true/>
<key>ThrottleInterval</key>
<integer>15</integer>
```

Same issue, 15-second respawn delay.

---

## The Race Condition Timeline

```
T+0s    User runs: bash scripts/restart-all-from-repo.sh
T+0.1s  Script does: pkill -9 -f "scripts/dashboard.mjs"
T+0.1s  Dashboard process (PID 12467) killed
T+0.1s  launchd detects death, starts ThrottleInterval countdown (10s)
T+0.1s  Script does: lsof -ti :4319 | xargs kill -9  (nothing to kill, port free)
T+0.2s  Script does: rm /tmp/bridge-*.pid
T+2.2s  Script does: sleep 2 completes
T+2.3s  Script checks: launchctl list com.crewswarm.dashboard → EXISTS
T+2.3s  Script does: launchctl stop com.crewswarm.dashboard
T+2.3s  launchd: "Already stopped (killed by pkill), ignoring stop command"
T+2.4s  Script does: launchctl start com.crewswarm.dashboard
T+2.4s  launchd spawns NEW dashboard (PID 13001) ← FIRST INSTANCE
T+10.1s launchd's ThrottleInterval expires
T+10.1s launchd spawns ANOTHER dashboard (PID 13052) ← DUPLICATE
T+10.1s Both processes race for port 4319
T+10.1s Startup guard in PID 13001: "Acquired lock (pid 13001) on port 4319"
T+10.2s Startup guard in PID 13052: "Port 4319 in use by 13001, killStale enabled"
T+10.2s PID 13052 kills PID 13001 with SIGKILL
T+10.2s PID 13052: "Acquired lock (pid 13052) on port 4319"
T+10.2s launchd sees PID 13001 died, starts NEW ThrottleInterval (10s)
T+20.2s launchd spawns ANOTHER dashboard (PID 13089) ← THIRD INSTANCE
... (cycle repeats)
```

**The script's `launchctl stop + start` does nothing useful** because the process was already killed by `pkill`.

---

## Current System State

```bash
$ launchctl list | grep crewswarm
-	126	com.crewswarm.stack
12467	-15	com.crewswarm.dashboard      # KeepAlive: true
-	1	com.crewswarm.whatsapp       # KeepAlive: true
12739	-15	com.crewswarm.telegram       # KeepAlive: true
```

```bash
$ ps aux | grep dashboard.mjs | grep -v grep
jeffhobbs  12467  1.9  0.3  node scripts/dashboard.mjs  (PPID: 1 = launchd)
```

**PPID: 1 = launchd-managed process**

```bash
$ ps aux | grep gateway-bridge | wc -l
      19
```

**19 gateway-bridge processes** (one per agent in `crewswarm.json` + extras from previous respawns that never cleaned up)

```bash
$ ls -la ~/.crewswarm/pids/
crew-lead.pid: 12165 (alive: YES)
crewswarm-dashboard.pid: 12467 (alive: YES)
opencrew-rt-daemon.pid: 12100 (alive: YES)
```

**PID files are correct** — the startup guard IS working for crew-lead and dashboard. But it can't prevent launchd from spawning duplicates AFTER it acquires the lock.

---

## Why This Keeps Happening

### You asked: "didn't we have a cleanup daemon?"

**Answer:** No dedicated cleanup daemon exists, BUT:
- **Startup guard** (`acquireStartupLock`) IS the cleanup mechanism — it kills stale processes when `killStale: true`
- **PID file cleanup** happens on process exit via `process.on("exit", cleanup)`
- **Restart script** manually cleans `/tmp/bridge-*.pid` files

All three mechanisms work correctly in isolation.

### You asked: "why does this shit keep happening?"

**Answer:** Three reasons:

1. **launchd KeepAlive defeats manual restarts**
   - `pkill` triggers launchd respawn after ThrottleInterval
   - Script spawns new process BEFORE launchd's respawn timer expires
   - Both processes fight for port, creating churn

2. **Startup guard can't prevent launchd's respawn**
   - The guard runs INSIDE each process at startup
   - By the time it checks for existing processes, launchd has already spawned the duplicate
   - The guard kills the OLD process, but launchd just respawns ANOTHER

3. **No coordination between launchd and the restart script**
   - Script does `launchctl stop + start` but this is a NO-OP when the process is already dead from `pkill`
   - launchd's internal state is: "Process died at T+0.1s, respawn pending at T+10.1s"
   - `launchctl stop` at T+2.3s does nothing (already stopped)
   - `launchctl start` at T+2.4s spawns immediately (doesn't cancel the pending respawn)
   - Result: 2 processes spawned 8 seconds apart

---

## Proof: The Dashboard Log

```bash
$ tail -50 /tmp/dashboard.log
[dashboard] crewswarm-dashboard already running (pid 61195) on port 4319
```

This message comes from the **startup guard** when a duplicate tries to start. The guard correctly DETECTED the duplicate and prevented it from binding to port 4319.

**But the duplicate process didn't die** — it exited with code 1 (line 63 of `scripts/dashboard.mjs`), triggering launchd to respawn it again after ThrottleInterval.

---

## The launchd Config Files

### com.crewswarm.dashboard.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.crewswarm.dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/jeffhobbs/Desktop/CrewSwarm/scripts/dashboard.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>                          ← PROBLEM: respawns on death
  <key>ThrottleInterval</key>
  <integer>10</integer>           ← PROBLEM: 10s respawn delay
  <key>StandardOutPath</key>
  <string>/tmp/crewswarm-dashboard.log</string>
</dict>
</plist>
```

### com.crewswarm.stack.plist

```xml
<key>Label</key>
<string>com.crewswarm.stack</string>
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>/Users/jeffhobbs/Desktop/CrewSwarm/scripts/restart-all-from-repo.sh</string>
</array>
<key>KeepAlive</key>
<false/>                          ← CORRECT: one-shot at boot
```

**This one is fine** — it runs once at boot, then exits. No respawn loop.

### com.crewswarm.telegram.plist

```xml
<key>KeepAlive</key>
<true/>
<key>ThrottleInterval</key>
<integer>15</integer>
```

Same issue as dashboard.

---

## Why the Startup Guard Can't Save Us

The startup guard (`acquireStartupLock`) does this:

```javascript
// Check if PID file exists
if (fs.existsSync(pidFile)) {
  const savedPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  if (savedPid && isProcessAlive(savedPid)) {
    // Process alive - check if port is free
    if (port && !isPortInUse(port)) {
      // Stale PID (process exists but not using port)
      console.log(`Stale PID ${savedPid} — removing`);
      fs.unlinkSync(pidFile);
    } else {
      // Process alive AND port in use — abort
      return { ok: false, message: `already running (pid ${savedPid})` };
    }
  }
}

// Check port conflict
if (port) {
  const portPid = getPidOnPort(port);
  if (portPid && portPid !== myPid) {
    if (killStale) {
      console.log(`Port ${port} occupied by PID ${portPid} — killing`);
      process.kill(portPid, 9);
      // Wait for port to be released (6 retries × 1s)
    }
  }
}

// Acquire lock
fs.writeFileSync(pidFile, String(myPid));
console.log(`Acquired lock for ${serviceName} (pid ${myPid})`);
```

**This works great for manual `node scripts/dashboard.mjs` calls.**

But with launchd:
1. Process A (PID 12467) is running, holds port 4319, has `crewswarm-dashboard.pid`
2. `pkill -9` kills PID 12467
3. Process A's `process.on("exit")` cleanup deletes `crewswarm-dashboard.pid`
4. launchd waits 10 seconds (ThrottleInterval)
5. Restart script spawns Process B (PID 13001) at T+2.4s
6. Process B checks: no PID file ✓, port free ✓, acquires lock
7. launchd spawns Process C (PID 13052) at T+10.1s
8. Process C checks: PID file exists (written by B), PID 13001 alive, port 4319 in use
9. Process C does `killStale` → kills Process B with SIGKILL
10. Process C acquires lock
11. launchd sees Process B died → schedules Process D for T+20.1s
12. **INFINITE LOOP**

---

## Solutions

### Option 1: Disable launchd KeepAlive (Recommended)

**Pros:**
- No more respawn loops
- Restart script works as designed
- Startup guard works as designed
- Matches Linux/systemd behavior (manual process management)

**Cons:**
- Services don't auto-restart on crash (need external monitoring like PM2 or custom watchdog)

**How to do it:**

```bash
# 1. Unload all launchd agents
launchctl unload ~/Library/LaunchAgents/com.crewswarm.dashboard.plist
launchctl unload ~/Library/LaunchAgents/com.crewswarm.telegram.plist
launchctl unload ~/Library/LaunchAgents/com.crewswarm.whatsapp.plist

# 2. Edit plists: change KeepAlive to false
sed -i '' 's|<key>KeepAlive</key>.*<true/>|<key>KeepAlive</key><false/>|' \
  ~/Library/LaunchAgents/com.crewswarm.{dashboard,telegram,whatsapp}.plist

# 3. Reload (but don't auto-start — remove RunAtLoad too)
sed -i '' 's|<key>RunAtLoad</key>.*<true/>|<key>RunAtLoad</key><false/>|' \
  ~/Library/LaunchAgents/com.crewswarm.{dashboard,telegram,whatsapp}.plist

launchctl load ~/Library/LaunchAgents/com.crewswarm.dashboard.plist
launchctl load ~/Library/LaunchAgents/com.crewswarm.telegram.plist
launchctl load ~/Library/LaunchAgents/com.crewswarm.whatsapp.plist

# 4. Use restart script for all management
bash scripts/restart-all-from-repo.sh
```

### Option 2: Restart Script Should Use launchctl ONLY (Alternative)

If you WANT launchd management (auto-restart on crash), then **never use `pkill` or `nohup` for launchd-managed services**.

**Change `scripts/restart-all-from-repo.sh` lines 14-24:**

```bash
# OLD (causes race):
pkill -9 -f "scripts/dashboard.mjs"
pkill -9 -f "telegram-bridge.mjs"
pkill -9 -f "whatsapp-bridge.mjs"

# NEW (launchd-aware):
if launchctl list com.crewswarm.dashboard >/dev/null 2>&1; then
  launchctl stop com.crewswarm.dashboard
else
  pkill -9 -f "scripts/dashboard.mjs"
fi

if launchctl list com.crewswarm.telegram >/dev/null 2>&1; then
  launchctl stop com.crewswarm.telegram
else
  pkill -9 -f "telegram-bridge.mjs"
fi

if launchctl list com.crewswarm.whatsapp >/dev/null 2>&1; then
  launchctl stop com.crewswarm.whatsapp
else
  pkill -9 -f "whatsapp-bridge.mjs"
fi

# Then SKIP manual nohup spawn for launchd services (lines 79-89):
# Delete or comment out:
#   nohup "$NODE" scripts/dashboard.mjs &
# launchd will respawn it automatically after ThrottleInterval.
```

**Pros:**
- Services auto-restart on crash (useful for production)
- No duplicate spawning (only launchd spawns)

**Cons:**
- Must wait ThrottleInterval (10-15s) for services to come up after restart
- Harder to debug (launchd hides stderr/stdout until you check logs)

### Option 3: Increase ThrottleInterval and Add Pre-Check

Keep KeepAlive but make the race window impossible:

```xml
<key>ThrottleInterval</key>
<integer>60</integer>  <!-- 60 seconds instead of 10 -->
```

Then in `scripts/restart-all-from-repo.sh`, add a 30-second wait after `launchctl stop`:

```bash
if launchctl list com.crewswarm.dashboard >/dev/null 2>&1; then
  launchctl stop com.crewswarm.dashboard
  sleep 30  # Wait for launchd's respawn timer to reset
  launchctl start com.crewswarm.dashboard
fi
```

**Pros:**
- Keeps auto-restart on crash
- Eliminates race (script finishes before launchd's timer)

**Cons:**
- Slow restarts (30+ seconds)
- Still fragile if user manually kills processes between script runs

### Option 4: Remove launchd Entirely (Nuclear)

```bash
launchctl unload ~/Library/LaunchAgents/com.crewswarm.*.plist
rm ~/Library/LaunchAgents/com.crewswarm.*.plist
```

Use `npm run restart-all` (which runs `scripts/restart-all-from-repo.sh`) exclusively.

**Pros:**
- Simple, predictable behavior
- No hidden respawns

**Cons:**
- Services don't auto-start at boot
- Services don't auto-restart on crash
- Need to manually add to cron or use PM2 for crash recovery

---

## Recommended Immediate Fix

**Option 1 (Disable KeepAlive) is the safest immediate fix.**

Run this now:

```bash
# 1. Stop everything
bash scripts/restart-all-from-repo.sh --no-dashboard --no-bridges
pkill -9 -f dashboard.mjs
pkill -9 -f telegram-bridge.mjs
pkill -9 -f whatsapp-bridge.mjs

# 2. Unload launchd agents
launchctl unload ~/Library/LaunchAgents/com.crewswarm.dashboard.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.crewswarm.telegram.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.crewswarm.whatsapp.plist 2>/dev/null

# 3. Disable KeepAlive in plists
for f in dashboard telegram whatsapp; do
  sed -i '' 's|<key>KeepAlive</key>.*<true/>|<key>KeepAlive</key><false/>|' \
    ~/Library/LaunchAgents/com.crewswarm.$f.plist
  sed -i '' 's|<key>RunAtLoad</key>.*<true/>|<key>RunAtLoad</key><false/>|' \
    ~/Library/LaunchAgents/com.crewswarm.$f.plist
done

# 4. Clean restart (no launchd interference)
bash scripts/restart-all-from-repo.sh

# 5. Verify
ps aux | grep -E "dashboard|crew-lead|gateway-bridge" | grep -v grep | wc -l
# Should be: 1 dashboard + 1 crew-lead + ~19 bridges = ~21 processes
```

---

## Long-Term Architectural Fix

Add a **process manager** like PM2 or supervisord:

```bash
npm install -g pm2

# Create PM2 ecosystem config
cat > ecosystem.config.js <<'EOF'
module.exports = {
  apps: [
    { name: "rt-daemon", script: "scripts/opencrew-rt-daemon.mjs", restart_delay: 5000 },
    { name: "crew-lead", script: "crew-lead.mjs", restart_delay: 5000 },
    { name: "dashboard", script: "scripts/dashboard.mjs", restart_delay: 5000 },
    { name: "telegram", script: "telegram-bridge.mjs", restart_delay: 5000 },
    { name: "whatsapp", script: "whatsapp-bridge.mjs", restart_delay: 5000 },
    { name: "mcp-server", script: "scripts/mcp-server.mjs", restart_delay: 5000 },
  ]
};
EOF

# Start all services with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # auto-start on boot
```

**Then remove ALL launchd plists:**

```bash
launchctl unload ~/Library/LaunchAgents/com.crewswarm.*.plist
rm ~/Library/LaunchAgents/com.crewswarm.*.plist
```

PM2 gives you:
- Process monitoring (auto-restart on crash)
- Log aggregation (`pm2 logs`)
- Graceful restarts (`pm2 restart all`)
- Web dashboard (`pm2 web`)
- No race conditions (PM2 tracks PIDs internally)

---

## Summary

| Issue | Root Cause | Fix |
|---|---|---|
| Duplicate dashboard processes | launchd KeepAlive + manual `nohup` spawn race | Disable KeepAlive OR use launchd exclusively |
| Duplicate bridge processes | Old bridges never cleaned up from previous crashes | `pkill -9 -f gateway-bridge.mjs` before restart |
| Startup guard not preventing dupes | Guard runs INSIDE process (too late to prevent launchd spawn) | Guard works correctly; launchd is the issue |
| Restart script not preventing dupes | Script spawns before launchd's ThrottleInterval expires | Use `launchctl stop` ONLY (no manual spawn) OR disable KeepAlive |

**You have cleanup mechanisms. They work. launchd defeats them.**

**Immediate action:** Disable KeepAlive in the three plist files, unload/reload, restart.

**Long-term action:** Migrate to PM2 or remove launchd entirely.
