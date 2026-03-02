# Dashboard Quality Improvements - Completion Status

**Date**: 2026-03-01 4:00 PM  
**Status**: ✅ READY TO COMPLETE

---

## Remaining Tasks

### 1. **Replace 26 Remaining execSync Calls** ⏳

Current execSync usage in `dashboard.mjs`:

**Service Management (19 calls)**:
- Line 1404: `which gemini` → Use `commandExists('gemini')`
- Line 1684: `pgrep -f 'crew-lead.mjs'` → Use `isProcessRunning('crew-lead.mjs')`
- Line 1783: File picker (keep as-is, OS-specific)
- Line 3194: `pkill -9 -f "crew-lead.mjs"` → Use `killProcess('crew-lead.mjs', 'SIGKILL')`
- Line 3197: `lsof -ti :port | xargs kill -9` → Use `killProcessOnPort(port, true)`
- Line 3203: `pgrep -f "crew-lead.mjs"` → Use `isProcessRunning('crew-lead.mjs')`
- Line 3204: `lsof -ti :port` → Use `isPortInUse(port)`
- Line 3212: `pkill -f "opencode serve"` → Use `killProcess('opencode serve')`
- Line 3218: `which opencode` → Use `commandExists('opencode')`
- Line 3233: `pkill -f "mcp-server.mjs"` → Use `killProcess('mcp-server.mjs')`
- Line 3234: `lsof -ti :5020 | xargs kill -9` → Use `killProcessOnPort(5020, true)`
- Line 3241: `pkill -f "openclaw-gateway"` → Use `killProcess('openclaw-gateway')`
- Line 3244: `open -a OpenClaw` → Keep (OS-specific app launcher)
- Line 3274: `pkill -f "gateway-bridge.mjs --rt-daemon"` → Use `killProcess('gateway-bridge.mjs --rt-daemon')`
- Line 3287: `pkill -9 -f "crew-lead.mjs"` → Use `killProcess('crew-lead.mjs', 'SIGKILL')`
- Line 3290: `lsof -ti :port | xargs kill -9` → Use `killProcessOnPort(port, true)`
- Line 3292: `pkill -f "opencrew-rt-daemon"` → Use `killProcess('opencrew-rt-daemon')`
- Line 3294: `pkill -f "openclaw-gateway"` → Use `killProcess('openclaw-gateway')`
- Line 3296: `open -a OpenClaw` → Keep (OS-specific)
- Line 3298: `pkill -f "opencode serve"` → Use `killProcess('opencode serve')`
- Line 3300: `pkill -f "mcp-server.mjs"` → Use `killProcess('mcp-server.mjs')`
- Line 3301: `lsof -ti :5020 | xargs kill -9` → Use `killProcessOnPort(5020, true)`

**Engine Check (2 calls)**:
- Line 3490-3491: `which` command for engine detection → Use `commandExists(bin)`

**Summary**: 
- 22 calls can be replaced with helper functions
- 2 calls should remain (OS-specific `open -a`)
- 2 calls in engine check section

---

### 2. **Add Validation to Critical Endpoints** ⏳

Endpoints that need validation (High Priority):

1. `/api/agents-config/update` (POST) - Use `UpdateAgentConfigSchema`
2. `/api/build` (POST) - Use `StartBuildSchema`
3. `/api/pm-loop/start` (POST) - Use `StartPMLoopSchema`
4. `/api/services/restart` (POST) - Use `ServiceActionSchema`
5. `/api/services/stop` (POST) - Use `ServiceActionSchema`
6. `/api/skills` (POST) - Use `CreateSkillSchema`
7. `/api/skills` (DELETE) - Use `DeleteSkillSchema`
8. `/api/projects` (PUT) - Use `UpdateProjectSchema`
9. `/api/projects` (DELETE) - Use `DeleteProjectSchema`
10. `/api/memory/search` (POST) - Use `SearchMemorySchema`

All schemas already exist in `dashboard-validation.mjs`.

---

### 3. **Implement File Locking for Config Writes** ⏳

Locations that write to config files:

- `~/.crewswarm/crewswarm.json` - Agent configuration
- `~/.crewswarm/config.json` - System configuration  
- `~/.crewswarm/projects.json` - Project list
- `~/.crewswarm/cmd-allowlist.json` - Command allowlist

**Solution**: Add proper-lockfile for atomic writes

```bash
npm install proper-lockfile
```

Create helper:
```javascript
import lockfile from 'proper-lockfile';

export async function writeConfigSafely(filePath, data) {
  const lockOptions = {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    stale: 5000
  };
  
  let release;
  try {
    release = await lockfile.lock(filePath, lockOptions);
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (release) await release();
  }
}
```

---

## Estimated Effort

| Task | Lines | Time |
|------|-------|------|
| Replace execSync calls | ~50 replacements | 45 min |
| Add validation to 10 endpoints | ~150 lines | 30 min |
| Implement file locking | ~80 lines | 30 min |
| Test + verify | - | 15 min |
| **Total** | **~280 lines** | **2 hours** |

---

## Implementation Plan

### Phase 1: Replace execSync (45 min)

1. Import helpers at top of `dashboard.mjs`
2. Find/replace patterns:
   - `execSync(\`pgrep -f "${pattern}"\`, ...)` → `await isProcessRunning(pattern)`
   - `execSync(\`pkill -9 -f "${pattern}"\`, ...)` → `await killProcess(pattern, 'SIGKILL')`
   - `execSync(\`pkill -f "${pattern}"\`, ...)` → `await killProcess(pattern)`
   - `execSync(\`lsof -ti :${port} | xargs kill -9\`, ...)` → `await killProcessOnPort(port, true)`
   - `execSync(\`lsof -ti :${port}\`, ...)` → `await isPortInUse(port)`
   - `execSync(\`which ${cmd}\`, ...)` → `await commandExists(cmd)`
3. Mark functions as `async` where needed
4. Test service restart

### Phase 2: Add Validation (30 min)

1. Import validation schemas
2. For each endpoint:
   ```javascript
   // Before
   const { id, model } = JSON.parse(raw);
   
   // After
   const bodyResult = await parseJsonBody(req);
   if (!bodyResult.ok) return validationError(res, bodyResult.error);
   
   const validation = validate(UpdateAgentConfigSchema, bodyResult.data);
   if (!validation.ok) return validationError(res, validation.error);
   
   const { id, model } = validation.data;
   ```
3. Test validation with invalid inputs

### Phase 3: File Locking (30 min)

1. Install `proper-lockfile`
2. Create `writeConfigSafely` helper in `dashboard-helpers.mjs`
3. Replace all `fs.writeFileSync` for config files
4. Test concurrent writes

### Phase 4: Test (15 min)

1. `node --check scripts/dashboard.mjs`
2. Start dashboard
3. Test service restart (uses new helpers)
4. Test config update (uses validation + locking)
5. Monitor for errors

---

## Compatibility with launchd Fix

✅ **NO CONFLICTS** - The launchd fix modified plist files, not dashboard code.

The helper functions (`killProcess`, `killProcessOnPort`) work the same way as the old `execSync` calls, just with better error handling and no shell injection risk.

**launchd fix status**:
- KeepAlive disabled in 3 plist files ✓
- Services restart cleanly ✓
- No process duplication ✓

**Dashboard improvements**:
- Helper functions call `pkill`, `lsof`, `pgrep` directly (no shell)
- Same behavior, safer execution
- Compatible with disabled KeepAlive

---

## Success Criteria

After completion:
- ✅ **Zero execSync calls** in service management (except OS-specific `open`)
- ✅ **10 critical endpoints validated** with Zod schemas
- ✅ **Zero config file corruption** from concurrent writes
- ✅ **Zero syntax errors** (`node --check` passes)
- ✅ **Services restart cleanly** with new helpers
- ✅ **Better error messages** for debugging

---

## Ready to Execute

All prep work is done:
- ✅ Helpers exist in `dashboard-helpers.mjs`
- ✅ Schemas exist in `dashboard-validation.mjs`
- ✅ Imports already added to `dashboard.mjs`
- ✅ launchd fix compatible
- ✅ No conflicts with existing code

**Next**: Execute the 3 phases and test.
