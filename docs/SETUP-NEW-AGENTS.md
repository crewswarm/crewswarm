# Quick Start: Adding New Agents

**Last Updated:** 2026-02-20

## TL;DR
CrewSwarm agents are already "plugins" - just edit JSON, no code needed!

## Prerequisites
- Node.js 20+ and dependencies: `npm install`
- RT bus running on port 18889
- OpenCrew RT configured

## Steps to Add a New Agent

### 1. Edit Agent Config
**File:** `~/.crewswarm/crewswarm.json`

Add to `agents.list`:
```json
{
  "id": "your-agent-id",
  "model": "nvidia/moonshotai/kimi-k2.5",
  "identity": {
    "name": "AgentName",
    "theme": "Short description",
    "emoji": "🤖"
  },
  "tools": {
    "profile": "coding"
  }
}
```

**Available models:**
- `nvidia/moonshotai/kimi-k2.5` (Kimi K2.5, free, fast)
- `groq/llama-3.3-70b-versatile` (Llama 3.3, free, excellent tools)
- `xai/grok-3-mini` (Grok, paid, powerful)
- `opencode/big-pickle` (experimental)

**Tool profiles:**
- `coding`: Full tools (write, edit, bash, etc.)
- `research`: Read-only + web search
- `review`: Read + grep only

### 2. Restart Agent Bridges
```bash
node scripts/start-crew.mjs --stop
# Gateway auto-restarts in ~3 seconds
sleep 5
```

### 3. Add Routing in Gateway Bridge
**File:** `/Users/jeffhobbs/Desktop/CrewSwarm/gateway-bridge.mjs`

Find `OPENCREW_TO_OPENCLAW_AGENT_MAP` (around line 70):
```javascript
const OPENCREW_TO_OPENCLAW_AGENT_MAP = {
  "crew-main": "main",
  "your-rt-agent-name": "your-agent-id",  // ADD THIS
  // ...
};
```

### 4. Add to Swarm Agent List
Same file, find `OPENCREW_RT_SWARM_AGENTS`:
```javascript
const OPENCREW_RT_SWARM_AGENTS = (process.env.OPENCREW_RT_SWARM_AGENTS || 
  "crew-main,your-rt-agent-name,..."  // ADD HERE
)
```

### 5. Restart Gateway Bridges
```bash
cd ~ && bin/openswitchctl restart-agents
sleep 5
bin/openswitchctl status
```

### 6. Test New Agent
```bash
# Direct test via gateway
cd /Users/jeffhobbs/Desktop/CrewSwarm
node gateway-bridge.mjs --agent your-agent-id "Create test.txt with hello world"

# Test via swarm
bin/openswitchctl send your-rt-agent-name "Create example.js with a function"
```

## Example: Adding a "Researcher" Agent

**1. `~/.crewswarm/crewswarm.json`:**
```json
{
  "id": "researcher",
  "model": "groq/llama-3.3-70b-versatile",
  "identity": {
    "name": "Scholar",
    "theme": "Research specialist",
    "emoji": "📚"
  },
  "tools": {
    "profile": "research",
    "alsoAllow": ["web_search", "web_fetch"]
  }
}
```

**2. Restart gateway:** `node scripts/start-crew.mjs --stop`

**3. `gateway-bridge.mjs`:**
```javascript
const OPENCREW_TO_OPENCLAW_AGENT_MAP = {
  "crew-researcher": "researcher",
  // ...
};

const OPENCREW_RT_SWARM_AGENTS = "crew-main,crew-researcher,...";
```

**4. Restart agents:** `bin/openswitchctl restart-agents`

**5. Test:** `bin/openswitchctl send crew-researcher "Search for Rust async patterns"`

## Why NOT Extract to Plugin?

1. **Already configurable** - CrewSwarm is designed for JSON config
2. **No code duplication** - One gateway, many agents
3. **Shared infrastructure** - Memory, validation, telemetry
4. **Simpler maintenance** - One codebase, one deploy

## When to Create a Separate Plugin?

Only if you need:
- **Custom tool implementations** (requires custom agent code)
- **Different gateway protocol** (not WebSocket)
- **Standalone distribution** (no extra dependencies)

For 99% of use cases: **Just add agents to crewswarm.json!**

