# What's Hardcoded vs Dynamic for Engines?

**TL;DR**: YES, JSON files are loaded dynamically, BUT the routing logic (`shouldUse` functions) is still **hardcoded** in `lib/engines/runners.mjs`. There's a new `engine-registry.mjs` that's **not being used yet**.

---

## Current State: Hybrid System

### ✅ Dynamic (JSON-based)
1. **Engine metadata** (`engines/*.json`):
   - `engines/opencode.json`
   - `engines/cursor.json`
   - `engines/claude-code.json`
   - `engines/codex.json`
   - `engines/gemini-cli.json`
   - `engines/docker-sandbox.json`
   - `engines/crew-cli.json` ← **NEW**

2. **Loaded automatically** from two directories:
   ```javascript
   // In lib/runtime/config.mjs
   ENGINES_BUNDLED_DIR = "engines/"
   ENGINES_USER_DIR = "~/.crewswarm/engines/"
   
   function _loadAllEngineJSONs() {
     // Scans both dirs for *.json
     // Returns all engines with { id, bin, args, etc. }
   }
   ```

3. **Used by dashboard** to render:
   - Settings → Engines tab (cards)
   - Settings → Agents → Engine dropdown
   - Benchmarks → Engine selector

---

### ❌ Hardcoded (Still Manual)

1. **HARDCODED_ENGINE_IDS** (line 93 of config.mjs):
   ```javascript
   const HARDCODED_ENGINE_IDS = new Set([
     "opencode",
     "cursor",
     "claude-code",
     "codex",
     "docker-sandbox",
     "gemini-cli"
     // ⚠️ crew-cli is NOT in this list!
   ]);
   ```

2. **Routing functions** (in `lib/engines/runners.mjs`):
   - `shouldUseCursorCli()` — 10 lines of logic
   - `shouldUseClaudeCode()` — 12 lines of logic
   - `shouldUseCodex()` — 12 lines of logic
   - `shouldUseGeminiCli()` — 20 lines of logic
   - `shouldUseCrewCLI()` — 16 lines of logic ← **NEW**
   - `shouldUseOpenCode()` — 20 lines of logic
   - `shouldUseDockerSandbox()` — 10 lines of logic

3. **Priority chain** (in `lib/engines/rt-envelope.mjs`):
   ```javascript
   const useCursorCli = shouldUseCursorCli(payload, incomingType);
   const useClaudeCode = !useCursorCli && shouldUseClaudeCode(payload, incomingType);
   const useCodex = !useCursorCli && !useClaudeCode && shouldUseCodex(payload, incomingType);
   const useDockerSandbox = shouldUseDockerSandbox(payload, incomingType);
   const useCrewCLI = !useCursorCli && !useClaudeCode && !useCodex && !useDockerSandbox && shouldUseCrewCLI(payload, incomingType);
   const useGeminiCli = !useCursorCli && !useClaudeCode && !useCodex && !useDockerSandbox && !useCrewCLI && shouldUseGeminiCli(payload, incomingType);
   // ... 9 more lines for each engine
   ```

4. **Execution blocks** (80+ lines in rt-envelope.mjs):
   ```javascript
   if (useCursorCli) {
     reply = await runCursorCliTask(prompt, payload);
   } else if (useClaudeCode) {
     reply = await runClaudeCodeTask(prompt, payload);
   } else if (useCodex) {
     reply = await runCodexTask(prompt, payload);
   } else if (useCrewCLI) {
     reply = await runCrewCLITask(prompt, payload);
   }
   // ... etc for 7 engines
   ```

---

## Why It's Not Fully Dynamic

### The Problem

**Adding a new engine requires touching 4 files**:

1. `engines/new-engine.json` — Create engine descriptor ✅ (Dynamic)
2. `lib/runtime/config.mjs` — Add to `HARDCODED_ENGINE_IDS` ❌ (Manual)
3. `lib/engines/runners.mjs` — Write `shouldUseNewEngine()` function ❌ (Manual)
4. `lib/engines/rt-envelope.mjs` — Add routing priority + execution block ❌ (Manual)

**crew-cli is the exception** — we added it but skipped step 2, which is why it works but isn't in `HARDCODED_ENGINE_IDS`.

---

## What `loadGenericEngines()` Actually Does

```javascript
// In lib/runtime/config.mjs line 113:
export function loadGenericEngines() {
  return _loadAllEngineJSONs()
    .filter(e => !HARDCODED_ENGINE_IDS.has(e.id) && e.bin && e.args?.run);
}
```

**Translation**: "Give me all engine JSONs that are NOT hardcoded and have a `bin` + `args.run`"

**Purpose**: For **generic engines** (custom user engines like `my-custom-llm.json`)

**Examples of what this returns**:
- ✅ Any custom engine you put in `~/.crewswarm/engines/`
- ❌ OpenCode (in `HARDCODED_ENGINE_IDS`)
- ❌ Cursor CLI (in `HARDCODED_ENGINE_IDS`)
- ❌ crew-cli (has hardcoded routing logic, but NOT in the set!)

---

## The Solution: `engine-registry.mjs` (Not Used Yet)

There's a **brand new** `lib/engines/engine-registry.mjs` that solves this problem:

```javascript
// NEW: Priority-based dynamic registry
const ENGINES = [];

function registerEngine(engine) {
  // { id, priority: 100, shouldUse: (payload) => bool, run: (prompt) => Promise }
  ENGINES.push(engine);
  ENGINES.sort((a, b) => b.priority - a.priority); // Highest first
}

function selectEngine(payload, incomingType) {
  for (const engine of ENGINES) {
    if (engine.shouldUse(payload, incomingType)) {
      return engine;
    }
  }
  return null; // fallback to direct LLM
}
```

**This would eliminate ALL hardcoding!**

### How it would work:

```javascript
// In engines/crew-cli.json:
{
  "id": "crew-cli",
  "priority": 50,  // ← NEW: Between Docker (60) and Gemini (40)
  "shouldUse": "payload?.useCrewCLI || runtime === 'crew-cli'",  // ← JS expression
  "run": {
    "bin": "crew",
    "args": ["run", "-t", "{prompt}", "--json"]
  }
}
```

Then one `selectEngine()` call replaces ALL the hardcoded `if/else` chains!

---

## Why It's Not Dynamic Yet

### Current System (Hardcoded)
**Pros:**
- ✅ Explicit priority control
- ✅ Complex logic (e.g., Cursor Waves special case)
- ✅ Type-safe (TypeScript)
- ✅ Easy to debug (one function per engine)

**Cons:**
- ❌ Manual work to add engines
- ❌ 200+ lines of boilerplate
- ❌ Easy to introduce bugs (forgot to check higher priority engines)

### New System (Dynamic Registry)
**Pros:**
- ✅ Zero code changes to add engines
- ✅ User-definable engines
- ✅ Priority auto-sorted
- ✅ Eliminates cross-check boilerplate

**Cons:**
- ❌ Less explicit (hidden in loop)
- ❌ `shouldUse` must be a string (eval'd)
- ❌ Harder to debug (which engine matched?)
- ❌ Migration work (rewrite all 7 engines)

---

## What's Actually Dynamic Right Now

### ✅ Dashboard UI
- Engines tab reads `engines/*.json` dynamically
- Agents dropdown populates from `loadGenericEngines()` + hardcoded list
- No code changes needed for new engine cards

### ✅ Generic Engines
```javascript
// These work dynamically already:
const _genericEngines = loadGenericEngines?.() || [];
const genericEngineMatch = _genericEngines.find(eng => 
  shouldUseGenericEngine(eng, payload, incomingType)
);
if (genericEngineMatch) {
  reply = await runGenericEngineTask(prompt, payload);
}
```

**Example**: Put `langchain.json` in `~/.crewswarm/engines/`:
```json
{
  "id": "langchain",
  "bin": "langchain",
  "args": { "run": ["run", "{prompt}"] }
}
```
→ Automatically available! No code changes!

### ❌ Built-in Engines (Hardcoded)
- OpenCode, Cursor, Claude Code, Codex, Gemini, Docker, crew-cli
- All require manual `shouldUse*()` functions
- All require manual priority checks

---

## Is crew-cli Different?

**YES and NO:**

### YES (It's Integrated)
- ✅ Has `engines/crew-cli.json`
- ✅ Has `shouldUseCrewCLI()` function
- ✅ Has routing in rt-envelope
- ✅ Works in dashboard dropdowns

### NO (It's Not Special)
- ❌ NOT in `HARDCODED_ENGINE_IDS` (but should be?)
- ❌ Uses same manual pattern as other engines
- ❌ Not leveraging dynamic registry

---

## To Make It Fully Dynamic

### Option 1: Add crew-cli to Hardcoded List
```javascript
// In lib/runtime/config.mjs line 93:
const HARDCODED_ENGINE_IDS = new Set([
  "opencode",
  "cursor",
  "claude-code",
  "codex",
  "docker-sandbox",
  "gemini-cli",
  "crew-cli"  // ← ADD THIS
]);
```

**Result**: Matches other engines, clarifies it's not "generic"

---

### Option 2: Migrate All Engines to Dynamic Registry

**Big refactor**, but would eliminate ALL hardcoding:

1. Define engines in JSON with `shouldUse` expressions:
```json
{
  "id": "crew-cli",
  "priority": 50,
  "shouldUseExpr": "payload?.useCrewCLI === true || (runtime === 'crew-cli' || runtime === 'crewcli') || agentConfig?.useCrewCLI === true || env.CREWSWARM_CREW_CLI_ENABLED === '1'",
  "runFn": "runCrewCLITask"
}
```

2. Replace rt-envelope routing with:
```javascript
const selectedEngine = selectEngine(payload, incomingType, { prompt, loadAgentList });
if (selectedEngine) {
  reply = await selectedEngine.run(prompt, payload);
}
```

3. Delete 200+ lines of hardcoded priority checks

---

## Summary Table

| Component | Status | Dynamic? |
|-----------|--------|----------|
| **Engine JSON metadata** | ✅ Works | **YES** — auto-loaded from `engines/*.json` |
| **Dashboard UI** | ✅ Works | **YES** — renders from JSON |
| **Generic engines** | ✅ Works | **YES** — fully dynamic |
| **Built-in engine routing** | ✅ Works | **NO** — hardcoded `shouldUse*()` functions |
| **Priority chain** | ✅ Works | **NO** — hardcoded order in rt-envelope |
| **HARDCODED_ENGINE_IDS** | ⚠️ Incomplete | **NO** — crew-cli missing from set |
| **engine-registry.mjs** | ❌ Not used | **N/A** — exists but not integrated |

---

## Recommendation

### Short-term (Now)
Add crew-cli to `HARDCODED_ENGINE_IDS` for consistency:
```javascript
const HARDCODED_ENGINE_IDS = new Set([
  "opencode", "cursor", "claude-code", "codex", 
  "docker-sandbox", "gemini-cli", "crew-cli"
]);
```

### Long-term (Later)
Migrate to `engine-registry.mjs` pattern:
- Move all `shouldUse*()` logic to engine JSON files
- Replace 7 hardcoded functions with 1 dynamic loop
- Enable user-defined engines without code changes

---

**Bottom line**: The JSON files ARE loaded dynamically (dashboard uses them), but the **routing logic** is still hardcoded. The system is **hybrid** — metadata is dynamic, execution is manual.
