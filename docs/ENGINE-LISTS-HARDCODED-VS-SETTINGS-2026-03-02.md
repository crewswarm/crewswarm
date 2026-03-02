# Engine Lists: Hardcoded vs Settings-Driven

**Date:** 2026-03-02  
**Questions:** 
1. "crew cli?" (missing from bulk buttons?)
2. "doesnt this change if i turn/on/off an engine in settings?"  
3. "execution routes? json driven with off/on override? in settings?"

---

## Answer Summary

❌ **NO** - Engine lists are **100% hardcoded** HTML  
❌ **NO** - Settings toggles do NOT hide/show engines in bulk buttons  
✅ **YES** - Per-agent execution route can be set (but bulk buttons always show all)

---

## Current State

### 1. Bulk Set Buttons (Agents Tab)

**Location:** `frontend/index.html` lines 573-582

```html
<span>BULK SET CODING AGENTS →</span>
<button data-action="bulkSetRoute" data-arg="direct">💬 Direct API</button>
<button data-action="bulkSetRoute" data-arg="opencode">⚡ OpenCode</button>
<button data-action="bulkSetRoute" data-arg="cursor" data-arg2="sonnet-4.5-thinking">🖱 Cursor CLI · sonnet-4.5 reasoning</button>
<button data-action="bulkSetRoute" data-arg="cursor" data-arg2="gpt-5-codex">🖱 Cursor CLI · gpt-5-codex</button>
<button data-action="bulkSetRoute" data-arg="cursor" data-arg2="opus-thinking">🖱 Cursor CLI · opus thinking</button>
<button data-action="bulkSetRoute" data-arg="claudecode" data-arg2="claude-sonnet-4-5">📜 Claude Code · 4.5</button>
<button data-action="bulkSetRoute" data-arg="gemini" data-arg2="gemini-2.0-flash-exp">🔷 Gemini CLI · 2.0-flash</button>
<button data-action="bulkSetRoute" data-arg="codex">🟣 Codex CLI</button>
```

**Properties:**
- ✅ Static HTML (never changes)
- ✅ Always shows all engines
- ❌ Does NOT respect Settings toggles
- ❌ Does NOT check if CLI is installed
- ❌ Does NOT filter based on enabled/disabled

### 2. Settings Toggles

**Location:** Settings tab → Engines sub-tab

| Toggle | What It Does | Backend Endpoint |
|---|---|---|
| **Claude Code Executor** | Enables/disables Claude Code globally | `POST /api/settings/claude-code` |
| **Codex CLI Executor** | Enables/disables Codex CLI globally | `POST /api/settings/codex` |
| **Gemini CLI Executor** | Enables/disables Gemini CLI globally | `POST /api/settings/gemini-cli` |

**What "Enable" actually means:**
- Sets global default: `CREWSWARM_CLAUDE_CODE_ENABLED`, `CREWSWARM_CODEX_ENABLED`, `CREWSWARM_GEMINI_CLI_ENABLED`
- Stored in: `~/.crewswarm/crewswarm.json` `env` block
- **Does NOT hide buttons** in UI
- **Does NOT prevent manual assignment** via bulk buttons
- Used as **default when creating new agents**

### 3. Per-Agent Execution Routes

**Format in crewswarm.json:**

```json
{
  "agents": [
    {
      "id": "crew-coder",
      "model": "anthropic/claude-sonnet-4-5",
      "useOpenCode": false,      // ⚡ OpenCode
      "useCursorCli": false,     // 🖱 Cursor CLI
      "useClaudeCode": false,    // 📜 Claude Code
      "useCodex": false,         // 🟣 Codex CLI
      "useGeminiCli": false      // 🔷 Gemini CLI
    }
  ]
}
```

**Rules:**
- ✅ **Mutually exclusive** - only ONE can be `true` at a time
- ✅ If all are `false` → uses Direct API (LLM call)
- ✅ Clicking bulk buttons sets these flags for 7 coding agents

---

## "Crew CLI" Missing?

**Your observation:** "crew cli?" in the bulk buttons list

**Answer:** There is NO "crew-cli" engine. Possible confusion:

| What You Might Mean | What It Actually Is |
|---|---|
| **crew-cli** (the npm package) | Development tool, not an execution engine |
| **Cursor CLI** | ✅ In bulk buttons (`cursor`) |
| **Codex CLI** | ✅ In bulk buttons (`codex`) |
| **Gemini CLI** | ✅ In bulk buttons (`gemini`) |
| **Claude Code** | ✅ In bulk buttons (`claudecode`) |

**`crew-cli` package** (`/crew-cli` folder) is:
- The **CLI development tool** for memory, pipelines, etc.
- NOT an execution engine
- NOT something agents route through
- Used for: `crew chat`, `crew exec`, memory commands

---

## Settings Toggles vs Bulk Buttons

### Current Behavior (As Designed)

**Settings → Engines toggles:**
```
[Enable Claude Code] ← Turns on/off
```

**What happens when you toggle OFF:**
- ✅ Sets global default to disabled
- ✅ New agents won't use it by default
- ❌ **Does NOT hide** bulk button
- ❌ **Does NOT prevent** manual assignment
- ❌ **Does NOT update** existing agent configs

**Bulk buttons:**
- ✅ Always visible (regardless of Settings)
- ✅ Work even if engine is "disabled" in Settings
- ✅ Override per-agent route immediately

### Why It Works This Way

**Design rationale:**
1. **Settings toggle** = "Should this be the default for new agents?"
2. **Bulk buttons** = "Force all coding agents to use this RIGHT NOW"
3. **Per-agent config** = "This specific agent uses this engine"

**Precedence:**
```
Per-agent config (crewswarm.json)
  ↓ overrides
Settings default (env vars)
  ↓ overrides
Built-in defaults (Direct API)
```

---

## Should Bulk Buttons Respect Settings?

### Current State: NO

Bulk buttons always show all engines, even if:
- Engine is disabled in Settings
- CLI is not installed
- API key is missing

### Possible Improvements

**Option 1: Hide Disabled Engines (Dynamic Buttons)**

```javascript
// In agents-tab.js
async function renderBulkButtons() {
  const settings = await getJSON('/api/settings/engines-summary');
  // { claudeCode: { enabled: true, installed: true }, ... }
  
  const buttons = [];
  buttons.push({ id: 'direct', label: '💬 Direct API', always: true });
  buttons.push({ id: 'opencode', label: '⚡ OpenCode', always: true });
  buttons.push({ id: 'cursor', label: '🖱 Cursor CLI', always: true });
  
  if (settings.claudeCode?.enabled) {
    buttons.push({ id: 'claudecode', label: '📜 Claude Code' });
  }
  if (settings.codex?.enabled) {
    buttons.push({ id: 'codex', label: '🟣 Codex CLI' });
  }
  if (settings.geminiCli?.enabled) {
    buttons.push({ id: 'gemini', label: '🔷 Gemini CLI' });
  }
  
  // Render dynamically...
}
```

**Option 2: Show All But Disable (Visual Feedback)**

```html
<button data-action="bulkSetRoute" data-arg="codex" 
        class="btn-ghost" 
        disabled
        title="Codex CLI is disabled in Settings">
  🟣 Codex CLI
</button>
```

**Option 3: Show Warning (Current + Alert)**

```javascript
async function bulkSetRoute(route, model) {
  if (route === 'codex') {
    const settings = await getJSON('/api/settings/codex');
    if (!settings.enabled) {
      if (!confirm('Codex CLI is disabled in Settings. Enable and proceed?')) {
        return;
      }
      await postJSON('/api/settings/codex', { enabled: true });
    }
  }
  // ... proceed with bulk set
}
```

---

## What Happens When You Click a Bulk Button

**Example:** Click "🔷 Gemini CLI · 2.0-flash"

**Code path:**
```javascript
// 1. Click handler (frontend/src/app.js)
bulkSetRoute('gemini', 'gemini-2.0-flash-exp')

// 2. Loop through coding agents
const CODING_AGENTS = [
  'crew-coder',
  'crew-coder-front', 
  'crew-coder-back',
  'crew-frontend',
  'crew-fixer',
  'crew-architect',
  'crew-ml'
];

// 3. For each agent, set flags
for (const agentId of CODING_AGENTS) {
  await postJSON('/api/agents-config/update', {
    agentId,
    useOpenCode: false,
    useCursorCli: false,
    useClaudeCode: false,
    useCodex: false,
    useGeminiCli: true,  // ← Only this is true
    geminiCliModel: 'gemini-2.0-flash-exp'
  });
}

// 4. Backend updates crewswarm.json
// 5. Frontend refreshes agent cards
```

**Result:**
- ✅ All 7 coding agents now use Gemini CLI
- ✅ Saved to `~/.crewswarm/crewswarm.json`
- ✅ Takes effect immediately (no restart needed for config)
- ⚠️ Bridges need restart for changes to apply to running tasks

---

## Per-Agent "EXECUTION ROUTE" Section

**What you saw in the DOM:**

```
⚡ EXECUTION ROUTE PICK ONE — MUTUALLY EXCLUSIVE
💬 Direct API
⚡ OpenCode
🖱 Cursor CLI (free · sub)
🤖 Claude Code (api key)
🟣 Codex CLI (subscription)
🔵 Gemini CLI (free · OAuth)
```

**This is generated dynamically** per agent in `agents-tab.js`:

```javascript
// Render execution route buttons for each agent
const routeButtons = `
  <button ${agent.useOpenCode ? 'checked' : ''}>⚡ OpenCode</button>
  <button ${agent.useCursorCli ? 'checked' : ''}>🖱 Cursor CLI</button>
  <button ${agent.useClaudeCode ? 'checked' : ''}>🤖 Claude Code</button>
  <button ${agent.useCodex ? 'checked' : ''}>🟣 Codex CLI</button>
  <button ${agent.useGeminiCli ? 'checked' : ''}>🔵 Gemini CLI</button>
`;
```

**Properties:**
- ✅ Shows current agent's route (one highlighted)
- ✅ Reflects actual crewswarm.json config
- ❌ Still shows all engines (doesn't hide disabled ones)
- ✅ Click to change just this agent's route

---

## Recommendations

### Short-term (Quick Fix)

**Add visual indicators** to bulk buttons:

```html
<!-- Enabled engine -->
<button data-action="bulkSetRoute" data-arg="gemini">
  🔷 Gemini CLI · 2.0-flash
</button>

<!-- Disabled engine -->
<button data-action="bulkSetRoute" data-arg="codex" 
        style="opacity:0.5;" 
        title="⚠️ Codex CLI is disabled in Settings">
  🟣 Codex CLI
</button>
```

### Long-term (Better UX)

1. **Dynamic button rendering** - Load enabled engines from Settings API
2. **Disable (not hide) disabled engines** - Show them grayed out with tooltip
3. **Settings integration** - Quick "Enable" link in tooltip
4. **Install check** - Detect if CLI is actually installed before showing button

---

## Summary

**Your Questions Answered:**

1. **"crew cli?"**  
   No such engine. You might mean Cursor CLI, Codex CLI, or Gemini CLI (all present).

2. **"doesnt this change if i turn/on/off an engine in settings?"**  
   ❌ NO - Bulk buttons are hardcoded HTML and don't change based on Settings.

3. **"execution routes? json driven with off/on override? in settings?"**  
   ✅ YES - Routes are in `crewswarm.json` per agent  
   ❌ NO - Settings toggles don't override bulk button visibility  
   ✅ YES - Per-agent JSON config is the source of truth

**Current Design:**
- Bulk buttons: Always show all engines (hardcoded)
- Settings toggles: Set global defaults (doesn't affect buttons)
- Per-agent config: Final authority (stored in JSON)

**Improvement needed:**
- Make bulk buttons respect Settings state (hide/disable unavailable engines)
- Or: Keep current design but add warnings when clicking disabled engines
