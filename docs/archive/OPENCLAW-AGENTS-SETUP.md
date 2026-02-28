# OpenClaw Multi-Agent Setup

**Last Updated:** 2026-02-20

## Overview

OpenClaw agents (configured in `~/.openclaw/openclaw.json`) now power your swarm! Each `gateway-bridge` daemon routes tasks to specialized OpenClaw agents with real tool access.

## Current Agent Configuration

| OpenCrew RT Agent | OpenClaw Agent | Model | Role |
|-------------------|----------------|-------|------|
| `crew-main` | `main` | Kimi K2.5 | Main coordinator (Quill 🦊) |
| `crew-coder` | `coder` | Llama 3.3 70B | Code implementation (Codex ⚡) |
| `crew-pm` | `pm` | Kimi K2.5 | Project planning (Planner 📋) |
| `crew-qa` | `qa` | Llama 3.3 70B | Testing & validation (Tester 🔬) |
| `crew-fixer` | `fixer` | Kimi K2.5 | Bug fixing (Debugger 🐛) |
| `security` | `security` | Kimi K2.5 | Security review (Guardian 🛡️) |

## How It Works

```
Task arrives on OpenCrew RT channel
          ↓
gateway-bridge.mjs daemon receives task
          ↓
Maps OpenCrew agent name → OpenClaw agent ID
          ↓
bridge.chat(prompt, openclawAgentId, {...})
          ↓
OpenClaw Gateway (ws://127.0.0.1:18789)
          ↓
OpenClaw agent executes with ACTUAL TOOLS
          ↓
✅ Files created, commands run, real work done!
```

## Key Files

### 1. OpenClaw Agent Config
**File:** `~/.openclaw/openclaw.json`

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "model": "nvidia/moonshotai/kimi-k2.5",
        "identity": {
          "name": "Quill",
          "theme": "Circuit fox",
          "emoji": "🦊"
        },
        "tools": {
          "profile": "coding",
          "alsoAllow": ["web_search", "web_fetch"]
        }
      },
      {
        "id": "coder",
        "model": "groq/llama-3.3-70b-versatile",
        "identity": {
          "name": "Codex",
          "theme": "Code architect",
          "emoji": "⚡"
        },
        "tools": {
          "profile": "coding"
        }
      }
      // ... more agents
    ]
  }
}
```

**To add a new agent:**
1. Add entry to `agents.list` in `openclaw.json`
2. Restart OpenClaw gateway: `pkill -f openclaw-gateway`
3. Add mapping to `gateway-bridge.mjs`:
   ```javascript
   const CREWSWARM_TO_OPENCLAW_AGENT_MAP = {
     "your-rt-agent-name": "your-openclaw-id",
     // ...
   };
   ```
4. Restart gateway bridges: `bin/openswitchctl restart-agents`

### 2. Gateway Bridge Routing
**File:** `/Users/jeffhobbs/Desktop/OpenClaw/gateway-bridge.mjs`

**Lines 70-82:** Agent name mapping

```javascript
const CREWSWARM_TO_OPENCLAW_AGENT_MAP = {
  "crew-main": "main",
  "crew-pm": "pm",
  "crew-qa": "qa",
  "crew-fixer": "fixer",
  "crew-coder": "coder",
  "crew-coder-2": "coder",
  "security": "security",
};
```

**Lines 1776-1779:** Task routing to OpenClaw

```javascript
const openclawAgentId = CREWSWARM_TO_OPENCLAW_AGENT_MAP[CREWSWARM_RT_AGENT] || "main";
reply = await bridge.chat(finalPrompt, openclawAgentId, { idempotencyKey: dispatchKey });
```

## Tool Profiles

OpenClaw provides pre-configured tool profiles:

- **`coding`**: Full suite (read, write, edit, bash, grep, glob, etc.)
- **`research`**: web_search, web_fetch, read
- **`review`**: read, grep, bash (read-only)

**Custom permissions:**
```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["web_search"],
    "deny": ["bash"]
  }
}
```

## Why This Works vs OpenCode

| Feature | OpenCode CLI | OpenClaw Agents |
|---------|-------------|-----------------|
| **Tool execution** | ❌ Broken (build agent has no tools) | ✅ Works perfectly |
| **Agent modes** | Subagent restrictions | All agents are primary |
| **Model tool use** | Kimi doesn't call tools in CLI | Kimi calls tools via gateway |
| **Interactive** | Single-shot, no retry | WebSocket, streaming, multi-turn |
| **Config** | Complex (plugins, modes) | Simple JSON |

## Testing

**Test an agent directly:**
```bash
cd /Users/jeffhobbs/Desktop/OpenClaw
node gateway-bridge.mjs --agent coder "Create test.txt with hello world"
```

**Test via swarm:**
```bash
bin/openswitchctl send crew-coder "Create example.js with an add function"
```

**Check if file was created:**
```bash
ls -lh /Users/jeffhobbs/swarm/test-output/
```

## Validation

The `validateCodingArtifacts()` function in `gateway-bridge.mjs` checks that coding tasks produce actual code:

```javascript
// Must have one of:
- files_changed mentions
- Code blocks (```)
- Diffs/patches
- Tool call evidence

// Red flags:
- Pure chat (< 500 chars, no artifacts)
- Weasel words ("would", "should", "could") without code
```

If validation fails, the task is retried up to 3 times with feedback to the agent.

## Status & Monitoring

**Check agent status:**
```bash
bin/openswitchctl status
```

**View recent task completions:**
```bash
tail -50 ~/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/done.jsonl | jq -r '.payload.reply' | head -20
```

**View failures:**
```bash
tail -50 ~/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/issues.jsonl | jq -r '.payload.error'
```

**Dashboard:**
Open `http://127.0.0.1:4318` for the Swarm Monitor dashboard with RT Messages view.

## Next Steps

1. ✅ **Disable OpenCode routing** (done: `CREWSWARM_OPENCODE_ENABLED=0`)
2. ✅ **Add specialized OpenClaw agents** (done: 6 agents configured)
3. ✅ **Map RT agents to OpenClaw agents** (done: routing works)
4. 🔄 **Test multi-agent workflows** (in progress)
5. 📊 **Monitor success rates** (track in dashboard)

## Open Source

OpenClaw is open source: https://github.com/openclaw/openclaw

All config is in your local files - you have full control!

