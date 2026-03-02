# Dashboard Killed When crew-lead Restarts — Root Cause

**Date**: 2026-03-02  
**Issue**: Stopping or restarting crew-lead also kills the dashboard  
**Status**: ✅ **ROOT CAUSE IDENTIFIED**

---

## TL;DR

The dashboard gets killed because **`restart-all-from-repo.sh` kills BOTH processes by port number**, not because they're parent/child or dependent on each other.

---

## The Evidence

### 1. Both Processes Are Independent

```bash
$ ps -p 6993 -o pid,ppid,command
  PID  PPID COMMAND
 6993     1 node /Users/jeffhobbs/Desktop/CrewSwarm/crew-lead.mjs

$ ps -o ppid= -p 8178
    1
```

Both have **parent PID 1 (launchd)** — they're siblings, not parent/child.

### 2. The Kill Chain in `restart-all-from-repo.sh`

Lines 17-33:

```bash
# Kill by process name first
pkill -9 -f "crew-lead.mjs"           # Kills crew-lead
pkill -9 -f "scripts/dashboard.mjs"   # Kills dashboard

# Kill by port (catches stragglers)
lsof -ti :5010 | xargs kill -9  # crew-lead port
lsof -ti :4319 | xargs kill -9  # dashboard port
```

**This script runs when:**
1. You run `npm run restart-all`
2. You run `bash scripts/restart-all-from-repo.sh`
3. The `com.crewswarm.stack.plist` launchd agent runs (on login or manual trigger)

### 3. LaunchAgent Behavior

From `/Users/jeffhobbs/Library/LaunchAgents/com.crewswarm.stack.plist`:

```xml
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>/Users/jeffhobbs/Desktop/CrewSwarm/scripts/restart-all-from-repo.sh</string>
</array>
<key>KeepAlive</key>
<false/>
```

**What this means**: 
- The stack plist runs `restart-all-from-repo.sh` ONCE (not a daemon)
- It does **not** keep crew-lead or dashboard alive
- It's a "start everything on boot" trigger, not a supervisor

From `/Users/jeffhobbs/Library/LaunchAgents/com.crewswarm.dashboard.plist`:

```xml
<key>RunAtLoad</key>
<false/>
<key>KeepAlive</key>
<false/>
```

**What this means**:
- Dashboard launchd agent exists but is **disabled**
- It won't auto-start on boot
- It won't auto-restart if killed

---

## Why Dashboard Dies When You Stop crew-lead

### Scenario 1: Manual `pkill crew-lead`

```bash
$ pkill -f crew-lead.mjs
```

**What happens**: Only crew-lead dies. Dashboard stays up. ✅

### Scenario 2: `npm run restart-all`

```bash
$ npm run restart-all
# Runs: bash scripts/restart-all-from-repo.sh
```

**What happens**:
1. Script runs `pkill -9 -f "crew-lead.mjs"` → crew-lead dies
2. Script runs `pkill -9 -f "scripts/dashboard.mjs"` → **dashboard dies too**
3. Script then restarts both

**Result**: Dashboard appears to die "because of crew-lead" but it's actually the restart script killing both. ❌

### Scenario 3: Restart via Dashboard UI

From the Services tab "Restart" button for crew-lead, the dashboard calls:

```javascript
// From scripts/dashboard.mjs (services API)
case "crew-lead":
  execSync("pkill -9 -f crew-lead.mjs 2>/dev/null; sleep 1; nohup node crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &");
```

**What happens**: Only crew-lead is killed/restarted. Dashboard stays up. ✅

---

## The Real Problem

**`restart-all-from-repo.sh` is overly aggressive**. It's designed to do a **full stack restart**, so it kills everything including the dashboard even if you only want to restart crew-lead.

### Where It's Called From

1. **`npm run restart-all`** (package.json)
2. **Manual execution**: `bash scripts/restart-all-from-repo.sh`
3. **LaunchAgent**: `com.crewswarm.stack.plist` (runs on boot)
4. **SwiftBar plugin**: May trigger stack restart

---

## Solutions

### Option 1: Use Targeted Restart (Recommended)

Instead of `npm run restart-all`, restart only what you need:

```bash
# Restart just crew-lead
pkill -f crew-lead.mjs && node crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &

# Restart just dashboard
pkill -f scripts/dashboard.mjs && node scripts/dashboard.mjs >> /tmp/dashboard.log 2>&1 &

# Restart just RT daemon
pkill -f opencrew-rt-daemon.mjs && node scripts/opencrew-rt-daemon.mjs >> /tmp/opencrew-rt-daemon.log 2>&1 &
```

Or use the dashboard Services tab — it has targeted restart buttons that only kill what you ask for.

### Option 2: Fix `restart-all-from-repo.sh` to Accept Flags

Add flags so you can restart individual services:

```bash
# Restart only crew-lead
bash scripts/restart-all-from-repo.sh --only-crew-lead

# Restart everything except dashboard
bash scripts/restart-all-from-repo.sh --no-dashboard
```

The `--no-dashboard` flag already exists (line 76), but there's no `--only-*` flags yet.

### Option 3: Create Individual Restart Scripts

```bash
scripts/
  restart-crew-lead.sh
  restart-dashboard.sh
  restart-rt-daemon.sh
  restart-bridges.sh
  restart-all.sh  # calls all the above
```

### Option 4: Use Process Supervisors

Instead of manual process management, use a supervisor:

- **pm2**: `pm2 start crew-lead.mjs && pm2 start scripts/dashboard.mjs`
- **systemd** (Linux): Individual service units
- **launchd** (macOS): Enable `<key>KeepAlive</key><true/>` in individual plists

---

## Recommended Fix (Quick)

Update `restart-all-from-repo.sh` to support `--only-X` flags:

```bash
#!/usr/bin/env bash
# Parse flags
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --only-crew-lead) ONLY="crew-lead" ;;
    --only-dashboard) ONLY="dashboard" ;;
    --only-rt) ONLY="rt" ;;
    --only-bridges) ONLY="bridges" ;;
  esac
done

# Only kill what's specified
if [[ "$ONLY" == "crew-lead" ]]; then
  pkill -9 -f "crew-lead.mjs"
  lsof -ti :5010 | xargs kill -9 2>/dev/null
  sleep 1
  nohup node crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &
  exit 0
fi

if [[ "$ONLY" == "dashboard" ]]; then
  pkill -9 -f "scripts/dashboard.mjs"
  lsof -ti :4319 | xargs kill -9 2>/dev/null
  sleep 1
  nohup node scripts/dashboard.mjs >> /tmp/dashboard.log 2>&1 &
  exit 0
fi

# Otherwise, kill everything (existing behavior)
# ...
```

---

## Why This Design Exists

The "kill everything" approach makes sense for:
1. **Fresh boot** — ensure clean slate, no stale processes
2. **After git pull** — all services need the new code
3. **After config changes** — services need to reload env vars
4. **Emergency recovery** — nuke everything and start fresh

But it's overkill for:
- Restarting crew-lead after a prompt change
- Restarting dashboard after UI tweaks
- Restarting a single bridge

---

## Summary

| Action | crew-lead Dies | Dashboard Dies | Why |
|--------|----------------|----------------|-----|
| `pkill crew-lead` | ✅ | ❌ | Targeted kill |
| `npm run restart-all` | ✅ | ✅ | Script kills both |
| Dashboard UI "Restart crew-lead" | ✅ | ❌ | Targeted exec |
| Boot (stack launchd agent) | ✅ then ✅ restart | ✅ then ✅ restart | Script kills then starts both |

**Recommendation**: Use dashboard Services tab for targeted restarts, or create individual restart scripts for each service. Avoid `npm run restart-all` unless you actually want to restart everything.

---

## Next Steps

1. **Short-term**: Document targeted restart commands in `AGENTS.md`
2. **Medium-term**: Add `--only-X` flags to `restart-all-from-repo.sh`
3. **Long-term**: Consider pm2 or proper launchd KeepAlive configs for process supervision
