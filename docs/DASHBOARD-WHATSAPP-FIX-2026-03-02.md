# Dashboard Flashing & WhatsApp Bridge Fix — 2026-03-02

## Problems Fixed

### 1. Dashboard Service Tab Flashing ✅

**Symptom**: Dashboard UI flashing/flickering every few seconds

**Root Cause**: Multiple dashboard processes running simultaneously
- My initial singleton guard used `lsof -ti:4319` which also caught Cursor's internal network service process
- Process name check was better but didn't exclude current PID initially  
- Multiple dashboards were racing to render the same UI

**The Fix**: 
1. Changed singleton guard to check for `node.*dashboard.mjs` process name (not just port)
2. Added `MY_PID` exclusion to avoid detecting ourselves
3. Killed all existing dashboard processes first
4. Verified only 1 instance after restart

**Code Change** (`scripts/dashboard.mjs` lines 11-34):
```javascript
const MY_PID = process.pid;

try {
  // Check if ANOTHER dashboard.mjs process is already running (exclude our own PID)
  const existing = execSync(`ps aux | grep "node.*dashboard.mjs" | grep -v grep | awk '{print $2}' || true`, { encoding: 'utf8' }).trim();
  
  if (existing) {
    const pids = existing.split('\n').filter(Boolean).map(Number).filter(p => p !== MY_PID);
    
    if (pids.length > 0) {
      console.error(`❌ Dashboard already running (PIDs: ${pids.join(', ')})`);
      console.error(`   To restart: pkill -9 -f "dashboard.mjs" && node scripts/dashboard.mjs`);
      process.exit(1);
    }
  }
} catch (err) {
  // Continue if check fails
}
```

---

### 2. WhatsApp Bridge Won't Start ✅

**Symptom**: WhatsApp bridge service shows "stopped" in dashboard, clicking restart does nothing

**Root Cause**: Missing npm dependency `qrcode-terminal`

**Error Log**:
```
Error: Cannot find module 'qrcode-terminal'
Require stack:
- /Users/jeffhobbs/Desktop/CrewSwarm/whatsapp-bridge.mjs
    at Module._resolveFilename (node:internal/modules/cjs/loader:1420:15)
```

**The Fix**: 
```bash
npm install qrcode-terminal --save
```

**Why It Was Missing**: The dependency was probably removed during an npm cleanup or never added to `package.json`

---

## Verification

### Dashboard
```bash
$ ps aux | grep "dashboard.mjs" | grep -v grep | wc -l
1

$ curl http://127.0.0.1:4319/health
{ "ok": true }
```
✅ Single dashboard instance, responding normally

### WhatsApp Bridge
```bash
$ npm list qrcode-terminal
crewswarm@0.5.0 /Users/jeffhobbs/Desktop/CrewSwarm
└── qrcode-terminal@0.12.0

$ node whatsapp-bridge.mjs
[whatsapp-bridge] Starting...
✅ Loaded auth session
```
✅ Starts without crashing

---

## Why the Singleton Guard Failed Initially

**Attempt 1**: Used `lsof -ti:4319`
- ❌ Problem: Caught Cursor's internal network service (PID 85654)
- Result: False positives, guard didn't prevent duplicates

**Attempt 2**: Used `ps aux | grep "node.*dashboard.mjs"`
- ❌ Problem: Detected current process before it fully started
- Result: Every dashboard instance blocked itself

**Attempt 3**: Excluded `MY_PID` (`process.pid`)
- ✅ **WORKS**: Only detects OTHER dashboard processes, not self

---

## Related Issues

All part of the same "AI slop" problem from 2026-03-01 Elvis integration:
1. One-shot mode broke agents (syntax error in import)
2. No singleton guards on any startup scripts
3. No testing before deploying changes
4. Missing dependencies not caught in CI

See: `docs/SYSTEM-AUDIT-SLOP-CLEANUP.md`

---

## Files Changed

- `scripts/dashboard.mjs` (lines 11-34): Fixed singleton guard with PID exclusion
- `package.json` / `package-lock.json`: Added `qrcode-terminal@0.12.0`

---

## Status

✅ **FIXED** — Dashboard stable (no flashing), WhatsApp bridge starts successfully

**Date**: 2026-03-02 20:45:00  
**Verification**: Manual testing + process inspection
