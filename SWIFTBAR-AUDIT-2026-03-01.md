# SwiftBar Plugin Audit - Endpoints & Architecture

**Date:** March 1, 2026  
**Status:** ⚠️ NEEDS UPDATE - Using legacy scripts instead of REST API

## Current Architecture

### SwiftBar Plugin Files
1. **`scripts/openswitch.10s.sh`** - Main plugin (refreshes every 10s)
2. **`contrib/swiftbar/openswitch.10s.sh`** - Same as above (duplicate location)

### Service Restart Flow (Current)

```
SwiftBar Menu Click
    ↓
restart-service.sh (bash script)
    ↓
pkill + nohup (direct process management)
```

## Issues Found

### 🔴 CRITICAL: Not Using Dashboard REST API

**Problem:** SwiftBar calls `restart-service.sh` bash script which uses `pkill` + `nohup` directly instead of using the dashboard's validated REST API endpoints.

**Current code (line 143-153 in openswitch.10s.sh):**
```bash
echo "--$(_svc_icon $SVC_TG) Telegram Bridge | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=telegram"
echo "--$(_svc_icon $SVC_WA) WhatsApp Bridge | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=whatsapp"
echo "--$(_svc_icon $SVC_CL) crew-lead       | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=crew-lead"
echo "--$(_svc_icon $SVC_OC) Code Engine     | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=opencode"
echo "--$(_svc_icon $SVC_MCP) MCP + OpenAI API | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=mcp"
echo "--$(_svc_icon $SVC_DB) Dashboard       | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=dashboard"
```

**Why this is bad:**
1. ❌ Bypasses dashboard validation (ServiceActionSchema)
2. ❌ No input validation on service names
3. ❌ Direct `pkill` can be dangerous
4. ❌ No consistent error handling
5. ❌ Doesn't use the LaunchAgent infrastructure properly
6. ❌ Race conditions between launchd and manual restarts

### 🟡 MEDIUM: Inconsistent Service IDs

**Dashboard API expects these IDs:**
```javascript
enum: ['rt-bus', 'agents', 'crew-lead', 'telegram', 'whatsapp', 'opencode', 'mcp', 'openclaw-gateway', 'dashboard']
```

**SwiftBar uses these:**
```bash
telegram, whatsapp, crew-lead, opencode, mcp, dashboard
```

**Missing from SwiftBar:**
- `rt-bus` (RT message bus restart)
- `openclaw-gateway` (optional legacy service)

**Not needed but present:**
- Uses `openswitchctl` for rt-bus restart instead

### 🟢 GOOD: Correct Status Detection

SwiftBar correctly detects service status using:
- `pgrep -f` for process-based services ✅
- `lsof -i :PORT` for port-based services ✅
- Correct ports: RT=18889, crew-lead=5010, opencode=4096, mcp=5020, dashboard=4319 ✅

## Available Dashboard REST API Endpoints

### Service Management
```bash
# Get service status
GET /api/services/status
→ Returns: { services: [{id, label, running, pid, port, canRestart}] }

# Restart a service (WITH VALIDATION)
POST /api/services/restart
Body: { "id": "crew-lead" | "telegram" | "whatsapp" | "opencode" | "mcp" | "dashboard" | "rt-bus" | "agents" }
→ Validates with ServiceActionSchema
→ Returns: { ok: true } or { ok: false, error: "..." }

# Stop a service
POST /api/services/stop
Body: { "id": "..." }
→ Returns: { ok: true } or { ok: false, error: "..." }
```

### Agent Management
```bash
# Get agent list with status
GET /api/agents
→ Returns: { ok: true, agents: [...] }

# Restart individual agent
POST /api/agents/{agentId}/restart
→ Returns: { ok: true } or { ok: false, error: "..." }
```

## Recommended Changes

### 1. Replace `restart-service.sh` calls with REST API

**Before:**
```bash
bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=dashboard
```

**After:**
```bash
bash='curl' param1='-s' param2='-X' param3='POST' param4='http://127.0.0.1:4319/api/services/restart' param5='-H' param6='Content-Type: application/json' param7='-d' param8='{"id":"dashboard"}'
```

Or create a helper script:
```bash
#!/usr/bin/env bash
# scripts/swiftbar-restart-service.sh
SERVICE_ID="$1"
curl -s -X POST http://127.0.0.1:4319/api/services/restart \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$SERVICE_ID\"}"
```

### 2. Add RT Bus restart button

Currently missing from SwiftBar menu. Should add:

```bash
echo "--$(_svc_icon $SVC_RT) RT Message Bus | bash='curl' param1='-X' param2='POST' param3='$DASHBOARD_URL/api/services/restart' param4='-H' param5='Content-Type: application/json' param6='-d' param7='{\"id\":\"rt-bus\"}' terminal=false refresh=true"
```

### 3. Use consistent service IDs

Map SwiftBar service names to dashboard API enum:
```bash
telegram    → telegram      ✅ matches
whatsapp    → whatsapp      ✅ matches
crew-lead   → crew-lead     ✅ matches
opencode    → opencode      ✅ matches
mcp         → mcp           ✅ matches
dashboard   → dashboard     ✅ matches
rt-bus      → rt-bus        ⚠️ add to SwiftBar
agents      → agents        ⚠️ add to SwiftBar
```

## Benefits of Using REST API

1. ✅ **Input validation** - ServiceActionSchema validates service IDs
2. ✅ **Consistent behavior** - Same restart logic as dashboard UI
3. ✅ **Better error handling** - Returns structured error messages
4. ✅ **LaunchAgent integration** - Dashboard handles launchd properly
5. ✅ **Centralized logic** - One place to update restart behavior
6. ✅ **Audit trail** - Dashboard logs all restart requests
7. ✅ **Future-proof** - Works with any future dashboard enhancements

## Security Note

Currently `restart-service.sh` uses `pkill -f` with pattern matching, which is potentially dangerous:

```bash
pkill -f "dashboard.mjs"  # Could kill unintended processes
```

The dashboard REST API is safer because:
- It validates service IDs against a whitelist
- It uses the startup guard to prevent race conditions
- It properly handles LaunchAgents when available

## Implementation Priority

**P0 - High Priority:**
1. Replace all `restart-service.sh` calls with REST API calls
2. Add validation error display in SwiftBar
3. Add RT bus restart option

**P1 - Medium Priority:**
4. Remove/deprecate `restart-service.sh` (keep for backward compat temporarily)
5. Add "Stop" options for services (not just restart)
6. Show actual error messages from API in SwiftBar notifications

**P2 - Nice to Have:**
7. Add service start times (available in API response)
8. Add agent-specific restart buttons (already uses openswitchctl)
9. Add service logs viewer (already has log file links)

## Testing Checklist

After making changes:
- [ ] Test dashboard restart from SwiftBar
- [ ] Test crew-lead restart from SwiftBar
- [ ] Test MCP restart from SwiftBar
- [ ] Test Telegram restart from SwiftBar
- [ ] Test WhatsApp restart from SwiftBar
- [ ] Test OpenCode restart from SwiftBar
- [ ] Verify validation errors are handled
- [ ] Verify services actually restart (check PIDs)
- [ ] Verify LaunchAgents are used when available
- [ ] Verify no duplicate processes spawn

## Files to Update

1. **`scripts/openswitch.10s.sh`** - Main SwiftBar plugin
2. **`contrib/swiftbar/openswitch.10s.sh`** - Duplicate (sync or remove)
3. **`scripts/swiftbar-restart-service.sh`** (NEW) - API wrapper helper
4. **`scripts/restart-service.sh`** - Mark as deprecated, keep for backward compat

---

**Summary:** SwiftBar is currently using legacy bash scripts for service restarts instead of the validated REST API. This bypasses all the validation and safety features we just implemented. Should migrate to use `/api/services/restart` endpoint.
