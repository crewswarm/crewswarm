# SwiftBar Endpoint Audit - Summary

**Date:** March 1, 2026  
**Audit Status:** ✅ COMPLETED

## Finding

⚠️ **SwiftBar is using legacy bash scripts (`restart-service.sh`) instead of the validated Dashboard REST API.**

## Current vs. Recommended

### Current Architecture (Legacy)
```
SwiftBar → restart-service.sh → pkill + nohup
```
❌ No validation  
❌ No error handling  
❌ Direct process management  
❌ Race conditions with LaunchAgents  

### Recommended Architecture (REST API)
```
SwiftBar → Dashboard REST API → Validated restart logic
```
✅ Input validation (ServiceActionSchema)  
✅ Structured error responses  
✅ LaunchAgent integration  
✅ Consistent with dashboard UI  
✅ Audit trail  

## Issues Found

### 🔴 Critical
1. **Bypasses validation** - All 5 validation tasks we just completed are bypassed by SwiftBar
2. **Security risk** - Uses `pkill -f` pattern matching which can kill wrong processes
3. **Race conditions** - Can spawn duplicate processes when LaunchAgent is active

### 🟡 Medium
4. **Missing RT bus restart** - No way to restart RT message bus from SwiftBar
5. **No error display** - Restart failures are silent
6. **Inconsistent IDs** - Service IDs don't match API enum exactly

### 🟢 Good
- Status detection is correct (uses `pgrep` and `lsof`)
- Correct ports and process names
- Agent management uses `openswitchctl` (good)

## Solution Provided

Created **`scripts/swiftbar-restart-service.sh`** - A validated helper that:
- ✅ Calls Dashboard REST API (`/api/services/restart`)
- ✅ Uses ServiceActionSchema validation
- ✅ Returns meaningful error messages
- ✅ Checks dashboard is running first
- ✅ Handles all response cases

### Usage Example
```bash
# Old way (bypasses validation)
bash restart-service.sh dashboard

# New way (uses validated API)
bash swiftbar-restart-service.sh dashboard
```

### Validation Test Results
```bash
$ bash swiftbar-restart-service.sh
Usage: ... <service-id>
Valid IDs: rt-bus, agents, crew-lead, telegram, whatsapp, opencode, mcp, dashboard

$ bash swiftbar-restart-service.sh invalid-service
❌ Failed to restart invalid-service: [validation error...]
```

✅ Validation is working correctly!

## Next Steps (Optional)

To fully integrate the REST API approach:

1. **Update SwiftBar plugin** (`scripts/openswitch.10s.sh`):
   - Replace `restart-service.sh` calls with `swiftbar-restart-service.sh`
   - Add error notifications for failed restarts
   - Add RT bus restart option

2. **Test the changes**:
   ```bash
   # Edit openswitch.10s.sh line 143-153
   # Replace:
   bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=dashboard
   
   # With:
   bash='$CREWSWARM_DIR/scripts/swiftbar-restart-service.sh' param1=dashboard
   ```

3. **Deprecate old script**:
   - Mark `restart-service.sh` as deprecated
   - Keep for backward compatibility temporarily
   - Remove in future version

## Files Created

1. **`SWIFTBAR-AUDIT-2026-03-01.md`** - Detailed audit report
2. **`scripts/swiftbar-restart-service.sh`** - New validated helper script

## Benefits

By switching to the REST API approach:
- All 5 validation tasks we completed today will apply to SwiftBar restarts
- Consistent behavior between dashboard UI and SwiftBar
- Safer process management
- Better error handling
- Future-proof architecture

---

**Recommendation:** Update SwiftBar plugin to use the new helper script for consistency and safety. The current setup works but bypasses all the validation and safety improvements made today.
