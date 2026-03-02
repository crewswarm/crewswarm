# Emergency Patch Guide — CrewSwarm

This guide provides copy-paste ready fixes for the 5 most critical reliability issues identified in the March 2026 Audit.

---

## 1. Fix Silent Error Swallowing
**File:** `pm-loop.mjs` (and others)

**Before:**
```javascript
try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
```

**After:**
```javascript
try { 
  return JSON.parse(readFileSync(p, "utf8")); 
} catch (e) {
  console.error(`[PM-LOOP] Failed to parse config ${p}: ${e.message}`);
}
```

---

## 2. Fix SSE Memory Leak
**File:** `lib/crew-lead/http-server.mjs` (referenced in `crew-lead.mjs`)

**Action:** Ensure every SSE connection has a cleanup handler.
```javascript
req.on("close", () => {
  sseClients.delete(res);
  console.log("[SSE] Client disconnected, remaining:", sseClients.size);
});
```

---

## 3. Harden OpenCode Watchdog
**File:** `lib/engines/opencode.mjs`

**Action:** Add a hard `SIGKILL` fallback if `SIGTERM` fails after 5 seconds.
```javascript
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000);
  reject(new Error(`OpenCode timeout after ${CREWSWARM_OPENCODE_TIMEOUT_MS}ms`));
}, CREWSWARM_OPENCODE_TIMEOUT_MS);
```

---

## 4. Prevent RT Race Conditions
**File:** `lib/runtime/task-lease.mjs`

**Action:** Increase task lock wait time and add jitter.
```javascript
// In withTaskLock
await _sleep(40 + Math.random() * 20); // Add jitter to prevent thundering herd
```

---

## 5. Basic Path Sanitization
**File:** `scripts/dashboard.mjs`

**Action:** Add a helper to prevent path traversal in project creation.
```javascript
function isSafePath(p) {
  const resolved = path.resolve(p);
  return resolved.startsWith(path.resolve(OPENCLAW_DIR)) || resolved.startsWith(os.homedir());
}
// Use this before fs.mkdirSync(outputDir)
```

---

## Verification Checklist
- [ ] Restart `crew-lead` and verify SSE connections are cleaned up in logs.
- [ ] Trigger a timeout in OpenCode and verify no zombie processes remain (`ps aux | grep opencode`).
- [ ] Attempt to create a project with `outputDir: "../../etc"` and verify it is blocked.
