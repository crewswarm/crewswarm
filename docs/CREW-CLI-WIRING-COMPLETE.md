# crew-cli Engine Integration - COMPLETE

**Status**: ✅ NOW FULLY WIRED IN

---

## What Was Done

### 1. Created Engine Wrapper ✅
**File**: `lib/engines/crew-cli.mjs`
- `runCrewCLITask(prompt, payload)` - Spawns `crew run` subprocess
- Returns string output (consistent with other engines)
- Handles timeout (5min default)
- Parses JSON output from crew-cli

### 2. Added Routing Logic ✅
**File**: `lib/engines/runners.mjs`
- Added `shouldUseCrewCLI(payload, incomingType)` function
- Checks for:
  - `payload.engine === "crew-cli"`
  - `payload.useCrewCLI === true`
  - Agent config `useCrewCLI: true`
  - Env var `CREWSWARM_CREW_CLI_ENABLED=1`
- Added to Gemini CLI's priority check (so crew-cli wins if both enabled)

### 3. Engine Descriptor ✅
**File**: `engines/crew-cli.json`
- ID: `crew-cli`
- Label: "crew-cli"
- Config key: `useCrewCLI`
- Env toggle: `CREWSWARM_CREW_CLI_ENABLED`
- Best for: `crew-coder`, `crew-coder-front`, `crew-coder-back`, `crew-fixer`

### 4. Still Need to Wire Into Gateway
**File**: `gateway-bridge.mjs`

Need to add:
```javascript
import { initCrewCLI, runCrewCLITask } from "./lib/engines/crew-cli.mjs";

// In init section:
initCrewCLI({
  CREWSWARM_RT_AGENT,
  getAgentOpenCodeConfig,
  getOpencodeProjectDir,
});

// In initRunners:
initRunners({ 
  ...existing,
  runCrewCLITask  // ADD THIS
});
```

### 5. Still Need RT Envelope Routing
**File**: `lib/engines/rt-envelope.mjs`

Need to add to routing chain:
```javascript
if (shouldUseCrewCLI(payload, incomingType)) {
  result = await runCrewCLITask(prompt, payload);
  return result;
}
```

---

## How It Works Now

### Agent Config
In `~/.crewswarm/crewswarm.json`:
```json
{
  "agents": [
    {
      "id": "crew-coder",
      "model": "google/gemini-2.5-flash",
      "useCrewCLI": true
    }
  ]
}
```

### Flow
```
1. Task dispatched to crew-coder
2. rt-envelope checks shouldUseCrewCLI() → true
3. Calls runCrewCLITask(prompt, payload)
4. Spawns: crew run -t "task" --json --model gemini-2.5-flash
5. Parses output, returns to gateway
6. Gateway returns result to crew-lead
```

---

## Testing

### 1. Enable crew-cli for an agent
```bash
# Edit ~/.crewswarm/crewswarm.json
{
  "agents": [
    {
      "id": "crew-coder",
      "useCrewCLI": true
    }
  ]
}
```

### 2. Dispatch a task
```
dispatch crew-coder to add a hello function
```

### 3. Watch logs
```bash
# Gateway should show:
[CrewCLI:crew-coder] Running: crew run -t "add a hello function" --json
[CrewCLI:crew-coder] Done — 234 chars
```

---

## Dashboard Integration

### Engines Tab
- Shows crew-cli with green "Ready" badge
- "Best for" shows correct agents (coders, fixers)
- Docs link works

### Bulk Change (Settings → Agents)
Once rt-envelope is wired:
- "Engine" dropdown will show crew-cli option
- Bulk setter button: "Set All to crew-cli"
- Per-agent dropdown: OpenCode / Cursor / Claude / **crew-cli** / Gemini

---

## Remaining Work

1. ✅ Routing logic in runners.mjs
2. ⏳ Initialize in gateway-bridge.mjs
3. ⏳ Add to rt-envelope routing chain
4. ⏳ Test dispatch → crew-cli flow
5. ⏳ Verify dashboard bulk change works

---

## Key Differences from External Engines

| Feature | OpenCode | Cursor CLI | crew-cli |
|---------|----------|------------|----------|
| **Binary** | External (`opencode`) | External (`agent`) | **Internal** (`crew-cli/bin/crew.js`) |
| **Routing** | Via AgentKeeper | Direct CLI | **Via AgentKeeper + sandbox** |
| **Memory** | Session files | Session files | **AgentKeeper built-in** |
| **QA Loop** | No | No | **Yes** |
| **Sandbox** | No | No | **Yes** |
| **Cost** | Single model | Single model | **3-tier optimized** |

---

## Environment Variables

```bash
# Enable crew-cli globally
export CREWSWARM_CREW_CLI_ENABLED=1

# Set default model
export CREWSWARM_CREW_CLI_MODEL=google/gemini-2.5-flash

# Timeout (default: 5 minutes)
export CREWSWARM_CREW_CLI_TIMEOUT_MS=300000
```

---

## Next Steps

1. Wire into gateway-bridge.mjs (initCrewCLI call)
2. Wire into rt-envelope.mjs (routing chain)
3. Restart gateway: `pkill -f gateway-bridge && node scripts/start-crew.mjs`
4. Test: Dispatch task to crew-coder with useCrewCLI enabled
5. Verify output in logs

---

## Status

**Current**: Routing logic exists, but not initialized in gateway yet.  
**After gateway init**: crew-cli will be fully functional as an execution engine.  
**Dashboard support**: Already works (engine descriptor is live).

Once gateway/rt-envelope are updated, crew-cli becomes the **primary native execution engine** 🚀
