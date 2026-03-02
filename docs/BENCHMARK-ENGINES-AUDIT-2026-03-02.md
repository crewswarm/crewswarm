# Benchmark Runner Engine List Audit

**Date:** 2026-03-02  
**Question:** "do we have all clis? swarm? gemini? how much is hardcoded?"

---

## Current State

### Benchmark Runner Engines (HARDCODED)

**Location:** `frontend/index.html` lines 1220-1225

```html
<select id="benchmarkRunEngine">
  <option value="claude">Claude Code</option>
  <option value="opencode">OpenCode</option>
  <option value="cursor">Cursor CLI</option>
  <option value="codex">Codex CLI</option>
</select>
```

**Missing:**
- ❌ **Gemini CLI** (`gemini` or `gemini-cli`)
- ❌ **SwarmUI** (if that's a thing?)
- ❌ **Docker Sandbox** (maybe?)

### Chat Passthrough Engines (HARDCODED)

**Location:** `frontend/index.html` lines 189-195

```html
<select id="passthroughEngine">
  <option value="">🧠 Crew Lead (Commander)</option>
  <option value="claude">🟢 Claude Code</option>
  <option value="cursor">⚫ Cursor CLI</option>
  <option value="opencode">🟣 OpenCode</option>
  <option value="codex">🔵 Codex CLI</option>
  <option value="gemini">🔷 Gemini CLI</option>  <!-- ✅ HAS GEMINI -->
</select>
```

**Status:** ✅ Chat has Gemini, ❌ Benchmarks don't

---

## Comparison

| Engine | Chat Passthrough | Benchmark Runner | Backend Support |
|---|---|---|---|
| **Claude Code** | ✅ `claude` | ✅ `claude` | ✅ `/api/engine-passthrough`, `/api/benchmark-run` |
| **OpenCode** | ✅ `opencode` | ✅ `opencode` | ✅ Both endpoints |
| **Cursor CLI** | ✅ `cursor` | ✅ `cursor` | ✅ Both endpoints |
| **Codex CLI** | ✅ `codex` | ✅ `codex` | ✅ Both endpoints |
| **Gemini CLI** | ✅ `gemini` | ❌ **MISSING** | ? (check backend) |

---

## Hardcoded Locations (All Engines)

### 1. Chat Passthrough Engine Dropdown
- **File:** `frontend/index.html` line 188-195
- **Hardcoded:** Yes (static HTML)

### 2. Benchmark Runner Engine Dropdown  
- **File:** `frontend/index.html` line 1220-1225
- **Hardcoded:** Yes (static HTML)
- **Missing:** Gemini CLI

### 3. Model Dropdown Updates (Dynamic)
- **File:** `frontend/src/app.js` line 1416-1480 (`updatePassthroughModelDropdown`)
- **Partially dynamic:** Has model lists per engine, but engine keys are hardcoded

### 4. Passthrough Handler Labels
- **File:** `frontend/src/chat/chat-actions.js` line 401
- **Hardcoded:** Engine display labels object
```javascript
const engineLabels = { 
  claude: 'Claude Code', 
  cursor: 'Cursor CLI', 
  opencode: 'OpenCode', 
  codex: 'Codex CLI', 
  gemini: 'Gemini CLI', 
  'gemini-cli': 'Gemini CLI', 
  'docker-sandbox': 'Docker Sandbox' 
};
```
- **Note:** Includes `docker-sandbox` but NOT in any dropdown!

---

## Backend API Support

Need to check if backend actually supports Gemini CLI for benchmarks:

```bash
# Backend passthrough endpoint
POST /api/engine-passthrough
# Supports: claude, opencode, cursor, codex, gemini

# Backend benchmark runner endpoint  
POST /api/benchmark-run
# Supports: ??? (need to check dashboard.mjs)
```

---

## Fix Required

### Option 1: Add Gemini to Benchmark Runner (Quick Fix)

**File:** `frontend/index.html` line 1225 (after Codex)

```html
<select id="benchmarkRunEngine">
  <option value="claude">Claude Code</option>
  <option value="opencode">OpenCode</option>
  <option value="cursor">Cursor CLI</option>
  <option value="codex">Codex CLI</option>
  <option value="gemini">Gemini CLI</option>  <!-- ADD THIS -->
</select>
```

### Option 2: Dynamic Engine Loading (Better Long-term)

Create a centralized engine registry:

**New file:** `frontend/src/core/engines.js`

```javascript
export const ENGINES = [
  { id: 'claude', label: 'Claude Code', icon: '🟢', hasBenchmarks: true },
  { id: 'opencode', label: 'OpenCode', icon: '🟣', hasBenchmarks: true },
  { id: 'cursor', label: 'Cursor CLI', icon: '⚫', hasBenchmarks: true },
  { id: 'codex', label: 'Codex CLI', icon: '🔵', hasBenchmarks: true },
  { id: 'gemini', label: 'Gemini CLI', icon: '🔷', hasBenchmarks: true },
  { id: 'docker-sandbox', label: 'Docker Sandbox', icon: '🐳', hasBenchmarks: false },
];

export function renderEngineDropdown(elementId, options = {}) {
  const select = document.getElementById(elementId);
  if (!select) return;
  
  const engines = options.benchmarksOnly 
    ? ENGINES.filter(e => e.hasBenchmarks)
    : ENGINES;
  
  select.innerHTML = engines.map(e => 
    `<option value="${e.id}">${options.withIcons ? e.icon + ' ' : ''}${e.label}</option>`
  ).join('');
}
```

Then populate dropdowns dynamically in `app.js`:

```javascript
import { renderEngineDropdown } from './core/engines.js';

// On page load
renderEngineDropdown('passthroughEngine', { withIcons: true });
renderEngineDropdown('benchmarkRunEngine', { benchmarksOnly: true });
```

---

## What is "SwarmUI"?

You asked about "swarm" - there's no such engine currently. Possible interpretations:

1. **SwarmUI** - A Stable Diffusion UI (not relevant here)
2. **Crew Swarm** - The whole CrewSwarm system (not an engine)
3. **Multi-agent pipeline** - Already handled by crew-lead dispatch (not a CLI engine)

**Verdict:** No "swarm" engine to add. If you want multi-agent runs in benchmarks, that would be a new feature (dispatch to crew-coder instead of a CLI).

---

## Recommendation

**Immediate Fix:**
1. Add Gemini CLI option to benchmark runner dropdown (1 line change)
2. Rebuild frontend + restart dashboard

**Better Long-term:**
1. Create `engines.js` registry
2. Make dropdowns dynamic
3. Load from config or API endpoint (future: let users add custom engines)

---

## Backend Verification Needed

Before adding Gemini to benchmarks, verify:

```bash
# Check if /api/benchmark-run supports gemini engine
grep -A 50 '/api/benchmark-run' scripts/dashboard.mjs | grep -E 'gemini|engine'
```

If backend doesn't support it, need to add Gemini CLI handler to benchmark-run endpoint.

---

**Answer:**
- ✅ **Chat passthrough:** Has all CLIs (claude, opencode, cursor, codex, gemini)
- ❌ **Benchmark runner:** Missing Gemini CLI
- 📊 **Hardcoded:** All engine lists are static HTML (4 locations)
- 🔧 **Fix:** Add one `<option>` line OR refactor to dynamic loading

**No "swarm" engine exists** - if you want multi-agent benchmark runs, that's a separate feature.
