# Dashboard Crash Fix - crew-lead Stop

## Issue
When you clicked "Stop" on crew-lead in the dashboard, **the dashboard itself crashed**.

## Root Cause
The dashboard's `proxyToCL()` function (used for proxying requests to crew-lead on port 5010) **did not handle fetch errors**. When crew-lead was stopped:

1. Dashboard tried to proxy requests to `http://127.0.0.1:5010`
2. Fetch threw an error (connection refused)
3. Error was **unhandled** → crashed the entire dashboard process

### Before (Broken Code)
```javascript
async function proxyToCL(method, path_, body) {
  const token = getCLToken();
  const opts = { method, headers: {...}, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = body;
  const r = await fetch(CREW_LEAD_URL + path_, opts);  // ❌ Can throw!
  const text = await r.text();
  return { status: r.status, body: text };
}
```

**Problem**: No try/catch around `fetch()`. When crew-lead is down, `fetch()` throws `ECONNREFUSED`, which propagates up and crashes the dashboard.

## Fix Applied

### After (Fixed Code)
```javascript
async function proxyToCL(method, path_, body) {
  const token = getCLToken();
  const opts = { method, headers: {...}, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = body;
  try {
    const r = await fetch(CREW_LEAD_URL + path_, opts);
    const text = await r.text();
    return { status: r.status, body: text };
  } catch (err) {
    // crew-lead is down or unreachable - return 503 instead of crashing
    return { 
      status: 503, 
      body: JSON.stringify({ 
        error: "crew-lead unreachable", 
        detail: String(err?.message || err),
        hint: "Start crew-lead: npm run restart-all"
      })
    };
  }
}
```

**Solution**: Wrapped `fetch()` in try/catch. When crew-lead is down, return a graceful 503 error response instead of crashing.

## Impact

**Before**:
- Stop crew-lead → Dashboard crashes
- Multiple dashboard processes spawn
- User forced to manually `pkill` and restart

**After**:
- Stop crew-lead → Dashboard stays alive ✅
- API calls return 503 with helpful error message ✅
- Dashboard UI shows "crew-lead unreachable" instead of white screen ✅
- No crash, no duplicate processes ✅

## Testing

```bash
# 1. Start dashboard
node scripts/dashboard.mjs

# 2. Stop crew-lead (previously would crash dashboard)
pkill -9 -f "crew-lead"

# 3. Dashboard should stay alive and respond with 503
curl http://127.0.0.1:4319/api/health
# Expected: {"error":"crew-lead unreachable","hint":"Start crew-lead: npm run restart-all"}

# 4. Verify dashboard process still running
ps aux | grep dashboard.mjs
```

## Related Fixes

This is the **same pattern** we applied to other dashboard API endpoints:
- ZeroEval proxy (line 3364-3367)
- Service restart endpoints (added error handling)
- Benchmark runner (line 3433-3436)

**Pattern**: Any dashboard code that calls external services (crew-lead, APIs, etc.) must have try/catch to prevent crashes.

## Files Modified

- `scripts/dashboard.mjs` (line 3342-3359)

## Status

✅ **FIXED** - Dashboard now resilient to crew-lead stops/crashes.

**Tested**: 
- Dashboard survives crew-lead kill ✅
- Returns 503 with helpful message ✅
- No duplicate processes spawned ✅
- No logs show crash ✅

## Prevention

**Code review checklist** for dashboard changes:
- [ ] All `fetch()` calls wrapped in try/catch
- [ ] All `execSync()` calls wrapped in try/catch
- [ ] All file reads wrapped in try/catch
- [ ] Error responses include helpful hints for users

**Pattern to follow**:
```javascript
try {
  const result = await externalCall();
  return { status: 200, body: result };
} catch (err) {
  return { 
    status: 503, 
    body: JSON.stringify({ 
      error: "service unreachable",
      detail: String(err?.message || err),
      hint: "How to fix this..."
    })
  };
}
```
