# Dashboard Settings Toggles — Do They Do Anything?

**TL;DR**: The **ON/OFF buttons** in Settings → Engines work, but they're **global switches** that only matter if you don't have per-agent overrides. The **engines still show up in Agents tab** even when OFF because the dropdown shows **available** engines, not active ones.

---

## The Confusing Part: Two Levels of Control

### Level 1: Global Toggles (Settings → Engines)

These are the ON/OFF buttons you're asking about:

| Toggle | What It Does | Env Var Set |
|--------|-------------|-------------|
| **OpenCode** (🟢 ON) | Routes ALL coding agents through OpenCode globally | `CREWSWARM_OPENCODE_ENABLED=1` |
| **Claude Code** (🤖 ON) | Routes ALL agents through Claude Code CLI | Sets internal toggle via API |
| **Cursor CLI** | No toggle shown — uses per-agent config only | N/A |
| **Codex** (🟣 ON) | Routes ALL agents through Codex CLI | Sets internal toggle via API |
| **Gemini CLI** (🔵 ON) | Routes ALL agents through Gemini CLI | `CREWSWARM_GEMINI_CLI_ENABLED=1` |
| **crew-cli** | No UI toggle yet (engine just added) | `CREWSWARM_CREW_CLI_ENABLED=1` |

**What "Global" Means**:
- When ON: **All agents** use this engine (unless overridden per-agent)
- When OFF: Agents use their **per-agent config** or direct LLM calls

---

### Level 2: Per-Agent Overrides (Settings → Agents)

Each agent can override the global setting:

```json
{
  "agents": [
    {
      "id": "crew-coder",
      "useOpenCode": true,        // ← Overrides global toggle
      "useClaudeCode": false,     // ← Explicit override
      "useCrewCLI": true          // ← Overrides global toggle
    }
  ]
}
```

**Priority order** (highest to lowest):
1. **Per-agent config** (`useOpenCode: true` in crewswarm.json)
2. **Global toggle** (Settings → Engines ON/OFF button)
3. **Default** (direct LLM call or OpenCode if installed)

---

## So... Do The Toggles Actually Work?

**YES**, but their effect depends on whether you have per-agent overrides:

### Scenario 1: No Per-Agent Overrides
```json
{
  "agents": [
    { "id": "crew-coder" }  // No engine specified
  ]
}
```

**If OpenCode toggle is ON**: crew-coder uses OpenCode ✅  
**If OpenCode toggle is OFF**: crew-coder uses direct LLM ✅

---

### Scenario 2: With Per-Agent Override
```json
{
  "agents": [
    { "id": "crew-coder", "useClaudeCode": true }
  ]
}
```

**If OpenCode toggle is ON**: crew-coder STILL uses Claude Code ❌ (override wins)  
**If OpenCode toggle is OFF**: crew-coder STILL uses Claude Code ❌ (override wins)

**The global toggle is ignored** when a per-agent config exists.

---

## Why Do Engines Show in Agents Tab When OFF?

The dropdown in **Settings → Agents** shows **all available engines**, not just active ones:

```javascript
// Agents tab dropdown options:
- OpenCode ← Always shown (if installed)
- Cursor CLI ← Always shown (if installed)
- Claude Code ← Always shown (if API key set)
- Codex ← Always shown (if installed)
- Gemini CLI ← Always shown (if installed)
- crew-cli ← Always shown (always available)
```

**Why?** Because you might want to:
1. Turn OFF the global toggle (so most agents use direct LLM)
2. But set **one specific agent** to use that engine (per-agent override)

**Example:**
- Global OpenCode toggle: **OFF**
- But crew-coder specifically: `useOpenCode: true`
- Result: Only crew-coder uses OpenCode, all others use direct LLM ✅

---

## Do You Need crew-cli Toggle ON?

**NO** — crew-cli doesn't have a Settings → Engines toggle yet!

To use crew-cli, you must:

### Option 1: Set Per-Agent
```json
{
  "agents": [
    { "id": "crew-coder", "useCrewCLI": true }
  ]
}
```

### Option 2: Set Global Env Var
```bash
export CREWSWARM_CREW_CLI_ENABLED=1
```

### Option 3: Use Dashboard Bulk Setter
Settings → Agents → Select "crew-cli" from dropdown → Save

---

## The Engine Priority Chain

When a task is dispatched to an agent, the gateway checks in this order:

```
1. Is useCursorCli set? → Use Cursor CLI
2. Is useClaudeCode set? → Use Claude Code
3. Is useCodex set? → Use Codex
4. Is useDockerSandbox set? → Use Docker
5. Is useCrewCLI set? → Use crew-cli  ← NEW
6. Is useGeminiCli set? → Use Gemini CLI
7. Is CREWSWARM_OPENCODE_ENABLED=1? → Use OpenCode
8. Is OpenCode installed? → Use OpenCode (fallback)
9. None of the above? → Direct LLM call
```

**So even if a toggle is OFF**, a per-agent config can still activate that engine.

---

## Which Engines Show Up Where?

### Settings → Engines (Toggles)
- OpenCode (🟢 ON/OFF button)
- Claude Code (🤖 ON/OFF button)
- Codex (🟣 ON/OFF button)
- Gemini CLI (🔵 ON/OFF button)
- **crew-cli: NO TOGGLE YET** ⚠️

### Settings → Agents (Per-Agent Dropdown)
- OpenCode ← shown if installed
- Cursor CLI ← shown if installed
- Claude Code ← shown if API key
- Codex ← shown if installed
- Gemini CLI ← shown if installed
- **crew-cli** ← always shown (built-in)

### Settings → Security → Environment Variables
All engine toggles have env vars you can set manually:
```bash
CREWSWARM_OPENCODE_ENABLED=1
CREWSWARM_GEMINI_CLI_ENABLED=1
CREWSWARM_CREW_CLI_ENABLED=1
# etc.
```

---

## Summary

| Question | Answer |
|----------|--------|
| **Do toggles work?** | YES, but per-agent config overrides them |
| **Do engines show when OFF?** | YES — dropdown shows **available** engines, not active ones |
| **Do I need crew-cli toggle ON?** | NO — crew-cli has no toggle yet; use per-agent config or env var |
| **Which wins: toggle or per-agent?** | **Per-agent config always wins** |
| **Can I use engine without toggle?** | YES — set per-agent config instead |

---

## Recommended Setup

### For Most Users (Simple)
Use **global toggles** only, no per-agent overrides:
- Settings → Engines → Turn ON your preferred engine (e.g., OpenCode)
- All agents automatically use it
- Easy to switch by toggling OFF/ON

### For Power Users (Granular)
Use **per-agent config** in `~/.crewswarm/crewswarm.json`:
```json
{
  "agents": [
    { "id": "crew-coder", "useOpenCode": true },
    { "id": "crew-qa", "useCrewCLI": true },
    { "id": "crew-fixer", "useClaudeCode": true },
    { "id": "crew-pm", "useCrewCLI": false }
  ]
}
```

**Global toggles are ignored** when per-agent config exists.

---

## The Bug: crew-cli Has No Toggle

**crew-cli** is fully integrated but missing from Settings → Engines toggles!

**Workaround** until we add the UI:
```bash
# In Settings → Security → Environment Variables, add:
CREWSWARM_CREW_CLI_ENABLED=1
```

Or just set per-agent:
```json
{ "id": "crew-coder", "useCrewCLI": true }
```

---

**Bottom line**: The toggles work, but they're **optional**. Per-agent config is more powerful and always wins.
