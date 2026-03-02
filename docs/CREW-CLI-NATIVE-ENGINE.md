# crew-cli as Native Execution Engine

## The Original Vision

**crew-cli should be the PRIMARY code execution engine** - like OpenCode, Cursor CLI, or Claude Code, but **native to CrewSwarm** and optimized for our workflow.

---

## Why This Makes Sense

### Instead of calling external tools:
```
crew-lead → OpenCode (external, separate tool)
crew-lead → Cursor CLI (external, separate tool)
crew-lead → Claude Code (external, separate tool)
```

### Use our own engine:
```
crew-lead → crew-cli (internal, native, optimized)
```

**Benefits:**
- ✅ No external dependencies
- ✅ Tighter integration with CrewSwarm
- ✅ Built-in routing, sandbox, QA loop
- ✅ Git-aware context
- ✅ Shared memory via AgentKeeper
- ✅ Cost-optimized 3-tier architecture

---

## How It Works Now

### 1. crew-cli as Execution Engine

When an agent needs to write code, instead of calling `opencode run`, the gateway calls:

```javascript
import { runCrewCLITask } from './lib/engines/crew-cli.mjs';

const result = await runCrewCLITask(prompt, {
  agentId: 'crew-coder',
  model: 'google/gemini-2.5-flash',
  projectDir: '/path/to/project'
});

// Returns: { stdout, stderr, exitCode, files, patches, summary }
```

### 2. Wrapper Module

**File**: `lib/engines/crew-cli.mjs`

**What it does:**
- Spawns `crew run -t "task"` subprocess
- Handles timeout (default 5min)
- Parses JSON output
- Extracts files, patches, summary
- Returns structured result to gateway

### 3. Integration with Gateway

The gateway can now route tasks to crew-cli just like it routes to OpenCode:

```javascript
// In gateway-bridge.mjs
if (agent.engine === 'crew-cli') {
  const result = await runCrewCLITask(task, {
    agentId: agent.id,
    model: agent.model,
    projectDir: payload.projectDir
  });
  // Handle result...
}
```

---

## Command Mapping

| Gateway Action | crew-cli Command |
|----------------|------------------|
| Write code | `crew run -t "task"` |
| Chat | `crew chat "message"` |
| Plan | `crew plan "task"` |
| Execute shell | `crew exec "command"` |

---

## Advantages Over External Engines

### vs. OpenCode
- ✅ No separate install
- ✅ Shared memory (AgentKeeper)
- ✅ Built-in routing (3-tier)
- ✅ QA loop included
- ✅ Sandbox workflow

### vs. Cursor CLI
- ✅ More than single-shot responses
- ✅ Multi-agent coordination
- ✅ Review gates
- ✅ Cross-repo context

### vs. Claude Code
- ✅ Multi-model support
- ✅ Cost optimization (cheap routing)
- ✅ Native integration
- ✅ No external deps

---

## Configuration

### Environment Variables

```bash
# crew-cli binary path (auto-detected)
CREWSWARM_CREW_CLI_BIN=/path/to/crew

# Default model for crew-cli tasks
CREWSWARM_CREW_CLI_MODEL=google/gemini-2.5-flash

# Timeout (default: 5 minutes)
CREWSWARM_CREW_CLI_TIMEOUT_MS=300000

# Project directory (default: cwd)
CREWSWARM_OPENCODE_PROJECT=/path/to/project
```

### Per-Agent Config

In `~/.crewswarm/crewswarm.json`:

```json
{
  "agents": [
    {
      "id": "crew-coder",
      "model": "google/gemini-2.5-flash",
      "engine": "crew-cli"
    },
    {
      "id": "crew-main",
      "model": "xai/grok-4-1-fast-reasoning",
      "engine": "crew-cli"
    }
  ]
}
```

---

## crew-cli Output Format

crew-cli returns JSON when run with `--json`:

```json
{
  "status": "completed",
  "files": [
    {
      "path": "src/auth.ts",
      "action": "create",
      "content": "..."
    }
  ],
  "patches": [
    {
      "path": "package.json",
      "diff": "..."
    }
  ],
  "summary": "Created authentication module with JWT support",
  "routing": {
    "route": "CODE",
    "agent": "crew-coder"
  },
  "cost": {
    "tokens": 1234,
    "usd": 0.002
  }
}
```

The wrapper extracts this and returns it to the gateway for processing.

---

## Integration Steps

### ✅ Step 1: Create Wrapper (Done)
- `lib/engines/crew-cli.mjs` created
- Handles subprocess spawning, timeout, JSON parsing

### Step 2: Integrate with Gateway
- Add crew-cli to engine selection logic
- Route agent tasks to crew-cli when configured
- Handle crew-cli output format

### Step 3: Update Engine Descriptor
- Update `engines/crew-cli.json` with correct args
- Add `runCrewCLITask` as execution method

### Step 4: Test End-to-End
- Assign crew-coder to use crew-cli engine
- Dispatch task from dashboard
- Verify code is written via crew-cli
- Check output is returned to dashboard

### Step 5: Document
- Update AGENTS.md
- Add crew-cli execution examples
- Show how to configure per-agent

---

## Example Usage

### From Dashboard

1. Go to **Settings → Agents**
2. Select `crew-coder`
3. Set **Engine** to `crew-cli`
4. Save

Now when you dispatch to crew-coder:
```
dispatch crew-coder to add authentication with JWT
```

The gateway will call:
```bash
crew run -t "add authentication with JWT" --json
```

Instead of:
```bash
opencode run "add authentication with JWT"
```

---

## Why This Untangles the "Two Products" Problem

### Before (Confused)
- crew-cli was both a standalone CLI and part of the full stack
- VS Code extension connected to crew-lead (not crew-cli)
- crew-cli was "engine option #7" alongside external tools
- Unclear if crew-cli was for users or for internal use

### After (Clear)
- **crew-cli = PRIMARY execution engine** for CrewSwarm
- External engines (OpenCode, Cursor) are alternatives
- VS Code extension can use either:
  - crew-lead (orchestration) → crew-cli (execution)
  - OR crew-cli direct (standalone mode)
- One clear architecture

---

## Next Steps

1. **Integrate wrapper into gateway** - Route tasks to crew-cli
2. **Test with real agent** - Dispatch coding task via dashboard
3. **Document workflow** - How crew-lead → crew-cli flow works
4. **Add personality** - Gunner for crew-cli standalone mode
5. **Simplify docs** - Remove gateway dependencies from crew-cli standalone docs

---

## Status

✅ **Wrapper created**: `lib/engines/crew-cli.mjs`  
⏳ **Gateway integration**: Next step  
⏳ **Testing**: After gateway integration  

**The vision is now clear: crew-cli is the native execution engine, not an external tool.** 🚀
