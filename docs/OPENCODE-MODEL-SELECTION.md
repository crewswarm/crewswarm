# OpenCode Model Selection — Dynamic vs Hardcoded

**Issue**: crew-architect shows two different models:
- 💬 **Chat/Reasoning Model**: `deepseek/deepseek-reasoner` 
- ⚡ **Coding Model (OpenCode)**: `opencode/big-pickle`

**Question**: Should the coding model be dynamic or hardcoded?

---

## TL;DR

**It's DYNAMIC** ✅ — and working as designed. The two models serve **different purposes**:

1. **`model`** (`deepseek/deepseek-reasoner`) → Direct LLM calls for chat, reasoning, planning
2. **`opencodeModel`** (`opencode/big-pickle`) → Coding tasks when routed through OpenCode engine

---

## How It Works (Code Evidence)

From your `~/.crewswarm/crewswarm.json`:

```json
{
  "id": "crew-architect",
  "model": "deepseek/deepseek-reasoner",        // ← For direct LLM calls
  "opencodeModel": "opencode/big-pickle",       // ← For OpenCode engine
  "useCursorCli": true,
  "cursorCliModel": "sonnet-4.5-thinking",      // ← For Cursor engine
  "claudeCodeModel": "claude-sonnet-4-5",       // ← For Claude Code engine
  "geminiCliModel": "gemini-2.0-flash-exp"      // ← For Gemini CLI engine
}
```

### The Selection Logic (gateway-bridge.mjs:578-589)

```javascript
function getAgentOpenCodeConfig(agentId) {
  const agents = loadAgentList();
  const cfg = agents.find(a => a.id === agentId);
  
  // Returns agent-specific opencodeModel if set, otherwise falls back to global default
  return { 
    model: cfg.opencodeModel || null,  // ← This is dynamic per-agent
    ...
  };
}
```

From `lib/engines/opencode.mjs:20-22`:

```javascript
// Model priority: explicit payload > per-agent opencodeModel > global default
const agentOcCfg = getAgentOpenCodeConfig(agentId);
// Uses agentOcCfg.model → which comes from cfg.opencodeModel above
```

---

## Why Two Models?

### Scenario 1: Chat/Reasoning Task

```
User: "Design a microservices architecture for our app"
```

**What happens**:
1. Task doesn't require file editing
2. Gateway calls `callLLMDirect()` → uses `model: "deepseek/deepseek-reasoner"`
3. DeepSeek's reasoning model thinks deeply and provides architecture plan
4. No coding happens

**Model used**: `deepseek/deepseek-reasoner` ✅

### Scenario 2: Coding Task via OpenCode

```
User: "Implement the auth service from the architecture"
```

**What happens**:
1. Task requires file editing
2. Gateway routes to OpenCode engine (`useOpenCode: true` or by default)
3. OpenCode uses `opencodeModel: "opencode/big-pickle"` 
4. Big Pickle writes the actual code files
5. Result sent back to user

**Model used**: `opencode/big-pickle` ✅

### Scenario 3: Cursor CLI Task

```
User: "Refactor this component with better types"
```

**What happens**:
1. Task routed to Cursor CLI (`useCursorCli: true`)
2. Cursor uses `cursorCliModel: "sonnet-4.5-thinking"`
3. Sonnet 4.5 does the refactoring
4. Result sent back

**Model used**: `sonnet-4.5-thinking` ✅

---

## Is This Hardcoded or Dynamic?

**100% DYNAMIC** ✅

### Per-Agent Configuration (Your Setup)

| Agent | Chat Model | OpenCode Model | Cursor Model |
|-------|------------|----------------|--------------|
| crew-architect | `deepseek/deepseek-reasoner` | `opencode/big-pickle` | `sonnet-4.5-thinking` |
| crew-coder | `anthropic/claude-sonnet-4-5` | `opencode/big-pickle` | — |
| crew-main | `groq/llama-3.3-70b` | `opencode/big-pickle` | — |

**You can change any of these** in `~/.crewswarm/crewswarm.json` and they take effect immediately (on next task).

### Global Defaults (Fallback)

From `lib/runtime/config.mjs:88`:

```javascript
export const CREWSWARM_OPENCODE_MODEL = 
  process.env.CREWSWARM_OPENCODE_MODEL || 
  "groq/moonshotai/kimi-k2-instruct-0905";
```

If an agent doesn't have `opencodeModel` set, it uses this global default.

---

## Why `big-pickle` for Coding?

From `memory/model-ratings.md` and `docs/MODEL-RECOMMENDATIONS.md`:

| Model | Cost | Context | Why for Coding? |
|-------|------|---------|-----------------|
| `opencode/big-pickle` | **FREE** ✅ | 200K | Strong at code generation, no per-token cost, rate limited when heavy |
| `deepseek/deepseek-reasoner` | $1.00/M | 64K | Excellent reasoning but **paid** — better for planning than coding |

**Strategy**: Use free/cheap models for bulk coding work, save expensive reasoning models for complex planning.

---

## Dashboard Display

When you see in the dashboard:

```
crew-architect
· Architect
THINKER
💬 deepseek/deepseek-reasoner       ← Chat/reasoning model
⚡ opencode/big-pickle               ← Coding engine model
```

This is **showing both models** because crew-architect can use either depending on the task type:
- **Thinking/planning** → DeepSeek reasoner
- **Writing code** → Big Pickle via OpenCode

---

## How to Change It

### Option 1: Per-Agent (Recommended)

Edit `~/.crewswarm/crewswarm.json`:

```json
{
  "id": "crew-architect",
  "model": "anthropic/claude-sonnet-4-5",          // ← Change chat model
  "opencodeModel": "groq/llama-3.3-70b-versatile", // ← Change coding model
  "cursorCliModel": "gpt-5"                        // ← Change Cursor model
}
```

### Option 2: Global Default

Set env var:

```bash
export CREWSWARM_OPENCODE_MODEL="anthropic/claude-sonnet-4-5"
```

Or in `~/.crewswarm/crewswarm.json` → `env` block:

```json
{
  "env": {
    "CREWSWARM_OPENCODE_MODEL": "anthropic/claude-sonnet-4-5"
  }
}
```

### Option 3: Via Dashboard

Go to **Agents tab** → crew-architect → expand card → change "OpenCode Model" dropdown → Save.

---

## Is This the Right Setup?

**YES** ✅ Your config is optimal:

1. **DeepSeek reasoner** for planning/architecture → Cheap ($1/M), excellent reasoning
2. **Big Pickle** for coding → FREE, fast, good at code generation
3. **Sonnet 4.5** for Cursor CLI → Best-in-class for complex refactoring

**Cost profile**: Most coding tasks use free `big-pickle`, expensive DeepSeek only for deep thinking. Smart resource allocation.

---

## Summary Table

| Model Field | Purpose | When Used | Dynamic? |
|-------------|---------|-----------|----------|
| `model` | Direct LLM calls (chat, reasoning, planning) | When NOT routed through an engine | ✅ Per-agent |
| `opencodeModel` | OpenCode engine coding tasks | When `useOpenCode: true` or default fallback | ✅ Per-agent |
| `cursorCliModel` | Cursor CLI engine tasks | When `useCursorCli: true` | ✅ Per-agent |
| `claudeCodeModel` | Claude Code engine tasks | When `useClaudeCode: true` | ✅ Per-agent |
| `geminiCliModel` | Gemini CLI engine tasks | When `useGeminiCli: true` | ✅ Per-agent |

**All of these are dynamic and configurable per-agent.** No hardcoding. ✅

---

## Recommendation

**Keep your current setup** — it's well-optimized:
- Free model for bulk coding (`big-pickle`)
- Expensive reasoning model only when needed (`deepseek-reasoner`)
- Premium model for complex Cursor tasks (`sonnet-4.5-thinking`)

This minimizes cost while maximizing quality where it matters.
