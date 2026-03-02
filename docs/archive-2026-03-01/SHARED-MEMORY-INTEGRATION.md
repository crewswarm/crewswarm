# Shared Memory Integration — CLI ↔ Main CrewSwarm

**Cross-system memory persistence for all agents, CLIs, and sessions.**

This integration brings the CLI's advanced memory system (AgentKeeper + AgentMemory + MemoryBroker) to the main CrewSwarm installation, enabling true shared memory across:
- CLI (`crew chat`, `crew dispatch`)
- Gateway (agent bridges via RT bus)
- Crew-lead (dashboard chat)
- OpenCode / Cursor / Claude Code / Codex / Gemini CLI sessions
- Telegram / WhatsApp bridges

All agents now access the same persistent memory store — task history, cognitive facts, and local docs/code RAG blend automatically.

---

## What Changed

### Before (legacy)

- **Main CrewSwarm:** `memory/brain.md` + `memory/lessons.md` (append-only markdown files, no search, no deduplication)
- **CLI:** Separate `.crew/agentkeeper.jsonl` + `.crew/agent-memory/*.json` (lexical search, structured storage)
- **No sharing:** CLI memory and main memory were isolated

### After (unified)

- **Single storage root:** `~/.crewswarm/shared-memory/` (or `$CREW_MEMORY_DIR`)
- **Three memory layers:**
  1. **AgentKeeper** (`.crew/agentkeeper.jsonl`) — task results, append-only JSONL, lexical search
  2. **AgentMemory** (`.crew/agent-memory/*.json`) — cognitive facts, critical flags, tag-based retrieval
  3. **Collections** (docs/code RAG) — indexes local markdown and source files
- **MemoryBroker** — unified retrieval API that blends all three sources, scores by relevance

All systems read/write the same store. CLI bypass, Gateway dispatch, chat sessions — everyone sees the same memory.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Shared Memory Storage Root                    │
│              ~/.crewswarm/shared-memory/ (or custom)            │
├─────────────────────────────────────────────────────────────────┤
│ .crew/agentkeeper.jsonl        ← task memory (all agents)       │
│ .crew/agent-memory/            ← fact memory (per agent JSON)   │
│   ├── crew-lead.json                                            │
│   ├── crew-coder.json                                           │
│   └── ...                                                        │
│ docs/                          ← local docs collection (RAG)    │
└─────────────────────────────────────────────────────────────────┘
                            ▲
                            │ reads/writes
        ┌───────────────────┼───────────────────┬──────────────┐
        │                   │                   │              │
    ┌───▼────┐        ┌─────▼─────┐      ┌─────▼─────┐  ┌─────▼──────┐
    │  CLI   │        │  Gateway  │      │crew-lead  │  │ OpenCode/  │
    │ (crew) │        │  (RT bus) │      │  (chat)   │  │ Cursor/etc │
    └────────┘        └───────────┘      └───────────┘  └────────────┘
    
    All use: lib/memory/shared-adapter.mjs → crew-cli/dist/crew.mjs
```

### Key Files

| File | What it does |
|------|--------------|
| `lib/memory/shared-adapter.mjs` | Adapter layer — imports CLI modules, exposes unified API |
| `crew-cli/src/memory/agentkeeper.ts` | Task memory — stores every task result (JSONL) |
| `crew-cli/src/pipeline/agent-memory.ts` | Fact memory — stores cognitive facts (JSON) |
| `crew-cli/src/memory/broker.ts` | MemoryBroker — unified retrieval across all sources |
| `crew-cli/dist/crew.mjs` | Compiled bundle (required — run `cd crew-cli && npm run build`) |

---

## How to Use

### Set up shared memory root (optional)

By default, shared memory lives in `~/.crewswarm/shared-memory/`. To use a custom location:

```bash
# Add to ~/.crewswarm/crewswarm.json → env block
"env": {
  "CREW_MEMORY_DIR": "/path/to/custom/shared-memory"
}
```

Or export before starting services:

```bash
export CREW_MEMORY_DIR=/path/to/custom/shared-memory
npm run restart-all
```

### Build the CLI bundle (required)

The main CrewSwarm imports compiled CLI modules from `crew-cli/dist/`:

```bash
cd crew-cli && npm run build
```

This generates `crew-cli/dist/crew.mjs` which exports `AgentKeeper`, `AgentMemory`, and `MemoryBroker`. Without this, shared memory falls back to legacy brain.md files.

### Migrate existing brain.md to shared memory

```bash
# Dry run (see what would be migrated)
node scripts/migrate-brain-to-shared-memory.mjs --dry-run

# Migrate global brain.md + lessons.md + all project brains
node scripts/migrate-brain-to-shared-memory.mjs

# Migrate specific project only
node scripts/migrate-brain-to-shared-memory.mjs --project /path/to/project
```

Or from the dashboard: **Memory tab → 📦 Migrate brain.md to Shared Memory**

---

## API Reference

### From JavaScript (gateway-bridge.mjs, crew-lead.mjs, etc.)

```javascript
import {
  isSharedMemoryAvailable,    // Check if CLI modules loaded
  initSharedMemory,            // Create directory structure
  recallMemoryContext,         // Get formatted context block for prompt injection
  searchMemory,                // Get structured hits for UI display
  recordTaskMemory,            // Save task result to AgentKeeper
  rememberFact,                // Save cognitive fact to AgentMemory
  getMemoryStats,              // Get AgentMemory statistics
  getKeeperStats,              // Get AgentKeeper statistics
  compactKeeperStore,          // Dedupe + prune old entries
  CREW_MEMORY_DIR,             // Storage root path
} from './lib/memory/shared-adapter.mjs';

// Example: inject memory into agent task
const projectDir = '/path/to/project';
const taskText = 'Write an auth endpoint with JWT';

const memoryContext = await recallMemoryContext(projectDir, taskText, {
  maxResults: 5,
  includeDocs: true,      // Include local docs
  includeCode: false,     // Exclude code files
  preferSuccessful: true, // Boost successful tasks
  pathHints: ['src/auth.ts'], // Boost entries that touched these paths
  crewId: 'crew-coder'    // Which agent's memory to use
});

// memoryContext is a formatted markdown block ready for prompt injection
const fullPrompt = `${memoryContext}\n\n${taskText}`;
```

### From crew-lead chat

```
# Search memory
@@MEMORY search "authentication flow"
@@MEMORY search "deployment steps"

# Show statistics
@@MEMORY stats

# Store a fact (also stored in shared memory)
@@BRAIN crew-lead: project uses port 4319 for dashboard
```

### From dashboard

Navigate to **Memory tab** (🧠 in sidebar):
- View statistics (facts, keeper entries, storage size)
- Search memory by query
- Migrate brain.md to shared memory
- Compact AgentKeeper (dedupe + prune)

### From CLI

```bash
# Search memory (if in crew-cli/)
crew memory "authentication flow"

# Show stats
crew memory-stats

# Compact
crew memory-compact
```

---

## Memory Layers Explained

### 1. AgentKeeper (task memory)

**What:** Stores every task result in a local, append-only JSONL store (`.crew/agentkeeper.jsonl`).

**Purpose:** Allows agents to recall how they solved similar problems in the past.

**Format:**
```json
{
  "id": "uuid",
  "runId": "task-id",
  "tier": "worker",
  "task": "Write an auth endpoint with JWT",
  "result": "Created src/auth.ts with...",
  "agent": "crew-coder",
  "model": "anthropic/claude-sonnet-4-5",
  "timestamp": "2026-03-01T12:00:00.000Z",
  "metadata": { "success": true, "engineUsed": "opencode" }
}
```

**Retrieval:** Lexical similarity scoring (tokenize query → compare with task text).

**Automatic recording:** Every task completion in the gateway automatically records to AgentKeeper (rt-envelope.mjs line ~730).

### 2. AgentMemory (cognitive facts)

**What:** Persistence layer for "facts" that models should keep in mind across sessions.

**Purpose:** Continuity for high-level decisions, architecture choices, critical constraints.

**Format:**
```json
{
  "id": "uuid",
  "content": "Never use Vue — user prefers React",
  "critical": true,
  "timestamp": "2026-03-01T12:00:00.000Z",
  "tags": ["tech-stack", "user-preferences"],
  "provider": "cursor"
}
```

**Retrieval:** Lexical search + critical boost (critical facts rank higher).

**Manual storage:** Call `rememberFact(agentId, content, { critical, tags, provider })` or use `@@BRAIN` (crew-lead stores in both brain.md and AgentMemory).

### 3. Collections (RAG)

**What:** Indexes local `docs/` folder and markdown files.

**Purpose:** Ground agent responses in project-specific documentation.

**Retrieval:** Lexical search over chunked docs.

**Automatic:** MemoryBroker includes by default when `includeDocs: true`.

### MemoryBroker (unified API)

**What:** Single interface that queries all three sources, merges results, and ranks by score.

**Returns:** Array of hits with `{ source, score, title, text, metadata }`.

**Usage:**
```javascript
const hits = await searchMemory(projectDir, 'auth flow', {
  maxResults: 10,
  includeDocs: true,
  includeCode: false
});
// hits = [
//   { source: 'agentkeeper', score: 0.82, title: '[worker] Write auth endpoint', text: '...' },
//   { source: 'agent-memory', score: 0.75, title: '[CRITICAL] tech-stack', text: '...' },
//   { source: 'collections', score: 0.68, title: 'docs/auth.md:12', text: '...' }
// ]
```

For prompt injection, use `recallMemoryContext()` instead — returns formatted markdown block.

---

## How Memory is Injected

### Gateway (task dispatch)

When an agent receives a task via RT bus, `buildMiniTaskForOpenCode()` automatically injects memory:

```javascript
// gateway-bridge.mjs line ~744
async function buildMiniTaskForOpenCode(taskText, agentId, projectDir) {
  // ... resolve projectDir ...
  
  let sharedMemoryContext = '';
  if (isSharedMemoryAvailable()) {
    sharedMemoryContext = await recallMemoryContext(projectDir, taskText, {
      maxResults: 5,
      includeDocs: true,
      preferSuccessful: true,
      crewId: agentId
    });
  }
  
  // Fallback to legacy brain.md if shared memory not available
  if (!sharedMemoryContext) {
    // ... read brain.md files ...
  }
  
  return `[Memory context]\n${sharedMemoryContext}\n\n[${agentId}] ${taskText}`;
}
```

Memory is prepended to the task so the agent sees it before the instruction.

### Crew-lead (chat sessions)

Memory is injected **once** at session start and cached in history (prefix-cached by LLM providers → effectively free after first message):

```javascript
// lib/crew-lead/chat-handler.mjs line ~23
if (history.length === 0) {
  const memoryContext = await recallMemoryContext(projectDir, 'session initialization', {
    maxResults: 8,
    includeDocs: true,
    crewId: 'crew-lead'
  });
  
  if (memoryContext) {
    appendHistory(sessionId, "system", memoryContext);
  }
}
```

### CLI (crew chat / dispatch)

Same MemoryBroker — CLI uses it directly from TypeScript source (no adapter needed):

```typescript
// crew-cli/src/repl/index.ts
const memoryBroker = new MemoryBroker(projectDir);
const context = await memoryBroker.recallAsContext(task, {
  maxResults: 5,
  includeDocs: true
});
```

---

## Environment Variables

| Variable | Default | What it controls |
|----------|---------|------------------|
| `CREW_MEMORY_DIR` | `~/.crewswarm/shared-memory/` | Root directory for shared memory storage |

Set in `~/.crewswarm/crewswarm.json` → `env` block, or export before starting services.

---

## CLI Bypass Scenarios

### Scenario 1: Cursor session → CLI recalls result

1. User works in Cursor with MCP integration
2. Cursor agent (via CrewSwarm MCP server) dispatches to `crew-coder` and records task result to AgentKeeper
3. User switches to CLI: `crew chat "how did we implement auth?"`
4. CLI's MemoryBroker searches AgentKeeper, finds Cursor agent's task result, injects into context

**Result:** CLI knows what Cursor did, even though CLI wasn't involved in the original task.

### Scenario 2: CLI stores fact → Gateway uses it

1. User runs CLI: `crew chat "remember: never use Vue, always React"`
2. CLI parses user intent, stores fact to AgentMemory with `critical: true`
3. User dispatches task via dashboard: "build a UI component"
4. Gateway agent receives task, `buildMiniTaskForOpenCode()` calls `recallMemoryContext()`
5. MemoryBroker finds the critical "never use Vue" fact, injects into prompt

**Result:** Gateway agent respects CLI-stored preference without re-prompting user.

### Scenario 3: OpenCode session → Telegram recalls

1. User has crew-coder complete a complex refactor via OpenCode
2. Gateway records task result to AgentKeeper (automatic via rt-envelope.mjs)
3. User messages crew-lead via Telegram: "what's the status of the refactor?"
4. Crew-lead (Telegram bridge) injects shared memory at session start
5. MemoryBroker finds the OpenCode task result

**Result:** Crew-lead knows what OpenCode did and can summarize the refactor status.

### Scenario 4: Dashboard chat → CLI picks up context

1. User chats with crew-lead in dashboard, crew-lead stores decision via `@@BRAIN`
2. `@@BRAIN` handler writes to both `brain.md` (legacy) and AgentMemory (shared)
3. User switches to CLI terminal: `crew dispatch crew-qa "audit the new endpoint"`
4. CLI injects memory via MemoryBroker, includes crew-lead's brain fact

**Result:** QA agent sees the decision context from dashboard chat session.

---

## Session Continuity

### CLI sessions

CLI has native session persistence (`crew chat` keeps history in `.crew/chat-history.jsonl`). Shared memory is orthogonal — CLI sessions remember the conversation, and MemoryBroker injects task/fact memory from other agents.

### Gateway sessions

Gateway agents use OpenCode/Cursor/Claude Code/Codex session persistence (session IDs stored in `~/.crewswarm/sessions/<agentId>.session`). When an agent resumes, the CLI's memory is injected via `buildMiniTaskForOpenCode()`.

### Crew-lead sessions

Crew-lead stores per-session history in `memory/chat-sessions/<sessionId>.jsonl`. Shared memory is injected once at session start (line 1 of history) and prefix-cached.

---

## Dashboard Memory Tab

Navigate to **🧠 Memory** in the sidebar.

### Stats Cards

Shows live statistics for:
- **AgentMemory:** Total facts, critical facts, providers, date range
- **AgentKeeper:** Total entries, storage size, breakdown by tier/agent
- **Storage:** Location, availability status

### Search Panel

Search across all memory sources at once:
1. Enter query (e.g. "authentication flow")
2. Click **Search**
3. Results show source (agentkeeper/agent-memory/collections), score, preview text

### Actions

- **📦 Migrate brain.md to Shared Memory:** Converts legacy brain.md entries to AgentMemory facts
- **🗜️ Compact AgentKeeper:** Runs deduplication and pruning (removes old/duplicate entries)

---

## Commands Reference

### Crew-lead chat

```
@@MEMORY search "query text"  — search shared memory
@@MEMORY stats                — show statistics
@@BRAIN crew-lead: fact       — store fact (dual writes to brain.md + AgentMemory)
```

### CLI

```bash
crew memory "query text"      # Search AgentKeeper + AgentMemory + Collections
crew memory-stats             # Show memory statistics
crew memory-compact           # Compact AgentKeeper
```

### Migration script

```bash
node scripts/migrate-brain-to-shared-memory.mjs              # Migrate all
node scripts/migrate-brain-to-shared-memory.mjs --dry-run    # Preview
node scripts/migrate-brain-to-shared-memory.mjs --project /path/to/project
```

---

## REST API (dashboard backend)

### GET /api/memory/stats

Returns memory statistics.

**Response:**
```json
{
  "available": true,
  "storageDir": "/Users/user/.crewswarm/shared-memory",
  "agentMemory": {
    "totalFacts": 42,
    "criticalFacts": 8,
    "providers": ["crew-lead", "cursor", "cli"],
    "oldestFact": "2026-02-15T10:30:00Z",
    "newestFact": "2026-03-01T14:22:00Z"
  },
  "agentKeeper": {
    "entries": 127,
    "bytes": 245000,
    "byTier": { "worker": 98, "planner": 22, "orchestrator": 7 },
    "byAgent": { "crew-coder": 56, "crew-qa": 18, "crew-pm": 22 }
  }
}
```

### POST /api/memory/search

Search shared memory.

**Request:**
```json
{
  "query": "authentication flow",
  "maxResults": 10,
  "includeDocs": true,
  "includeCode": false
}
```

**Response:**
```json
{
  "query": "authentication flow",
  "hits": [
    {
      "source": "agentkeeper",
      "score": 0.823,
      "title": "[worker] Write JWT auth endpoint",
      "text": "Created src/auth.ts with JWT validation...",
      "metadata": { "agent": "crew-coder", "timestamp": "2026-02-28T..." }
    }
  ]
}
```

### POST /api/memory/compact

Compact AgentKeeper (dedupe + prune).

**Response:**
```json
{
  "entriesBefore": 150,
  "entriesAfter": 127,
  "bytesFreed": 34567
}
```

### POST /api/memory/migrate

Migrate brain.md to shared memory.

**Response:**
```json
{
  "ok": true,
  "imported": 38,
  "skipped": 12,
  "errors": 0
}
```

---

## Troubleshooting

### "Shared memory not available"

**Cause:** CLI dist bundle not built.

**Fix:**
```bash
cd crew-cli && npm run build
```

Verify: check that `crew-cli/dist/crew.mjs` exists.

### Memory not shared between CLI and gateway

**Cause:** Different `CREW_MEMORY_DIR` values or not set.

**Check:**
```bash
# Gateway (from main repo root)
node -e "console.log(require('fs').readFileSync(require('path').join(require('os').homedir(), '.crewswarm', 'crewswarm.json'), 'utf8'))" | grep CREW_MEMORY_DIR

# CLI
cd crew-cli
crew memory-stats  # Shows storage path
```

**Fix:** Set `CREW_MEMORY_DIR` consistently in `~/.crewswarm/crewswarm.json` → `env` block.

### "Failed to record task memory" in gateway logs

**Cause:** CLI bundle missing or storage directory not writable.

**Fix:**
1. Build CLI: `cd crew-cli && npm run build`
2. Check permissions: `ls -ld ~/.crewswarm/shared-memory`
3. Restart gateway: `npm run restart-all`

### Migration shows 0 imported entries

**Cause:** brain.md is empty or contains only headers/comments.

**Check:**
```bash
cat memory/brain.md
```

If you see only markdown headers (`#`, `##`) and no actual fact lines, there's nothing to migrate.

### Search returns no results

**Causes:**
1. Query too specific — try broader terms
2. No task history yet (agents haven't completed tasks)
3. AgentMemory empty (no facts stored via `@@BRAIN` or CLI)

**Fix:**
- Use `@@MEMORY stats` to see entry counts
- Store facts manually: `@@BRAIN crew-lead: some durable fact`
- Run tasks and let agents complete them (results auto-record)

---

## Performance Notes

### Prefix caching

Crew-lead injects memory once at session start. On subsequent messages in the same session, LLM providers (Anthropic, Google) cache the prefix → memory injection is effectively **free** after the first message.

### Retrieval speed

- **AgentKeeper:** O(n) lexical scan — fast for <500 entries (typical). Auto-compacts every 20 writes.
- **AgentMemory:** O(n) lexical scan — fast for <1000 facts. Manual compaction not needed (facts are small JSON).
- **Collections:** Builds index on first access (1-2s for 100 docs), then O(log n) search. Index cached in memory.

Typical retrieval latency: **<100ms** for blended search across all three sources.

### Storage limits

| Component | Default limit | Enforced by |
|-----------|---------------|-------------|
| AgentKeeper entries | 500 | Auto-compaction |
| AgentKeeper bytes | 2MB | Auto-compaction |
| AgentKeeper age | 30 days | Auto-compaction |
| AgentMemory facts | None | Manual (use `@@MEMORY stats` to monitor) |

Override AgentKeeper limits when constructing:
```javascript
const keeper = new AgentKeeper(projectDir, {
  storageDir: CREW_MEMORY_DIR,
  maxEntries: 1000,
  maxBytes: 5_000_000,
  maxAgeDays: 60
});
```

---

## Migration Strategy

### Recommended workflow

1. **Backup existing brain.md:**
   ```bash
   cp memory/brain.md memory/brain.md.backup
   ```

2. **Dry-run migration:**
   ```bash
   node scripts/migrate-brain-to-shared-memory.mjs --dry-run
   ```

3. **Migrate:**
   ```bash
   node scripts/migrate-brain-to-shared-memory.mjs
   ```

4. **Verify:**
   - Dashboard: **Memory tab → stats**
   - CLI: `crew memory-stats` (if in crew-cli/)
   - Chat: `@@MEMORY stats`

5. **Keep brain.md as primary source (hybrid approach):**
   - `@@BRAIN` writes to BOTH brain.md and AgentMemory
   - Agents see unified view via MemoryBroker
   - brain.md is human-readable audit trail
   - AgentMemory enables structured search

### Or: pure shared memory mode

After migration, you can stop appending to brain.md and rely entirely on AgentMemory:
1. Edit `lib/crew-lead/chat-handler.mjs` → remove brain.md append in `@@BRAIN` handler
2. Restart crew-lead: `pkill -f crew-lead.mjs && node crew-lead.mjs &`

---

## Future Enhancements

Potential additions (not yet implemented):

1. **Team sync:** Share memory across machines (S3 or shared folder)
2. **Vector embeddings:** Semantic search instead of lexical
3. **Memory decay:** Auto-prune less-relevant facts over time
4. **Cross-agent memory:** Explicitly tag facts for specific agent roles
5. **Memory analytics:** Dashboard graphs (facts/day, agent activity, query patterns)

See `crew-cli/docs/SHARED-MEMORY.md` for CLI-side team sync features (upload/download patterns).

---

## Quick Reference

| Task | Command | Where |
|------|---------|-------|
| Search memory | `@@MEMORY search "query"` | crew-lead chat |
| Show stats | `@@MEMORY stats` | crew-lead chat |
| Store fact | `@@BRAIN crew-lead: fact` | crew-lead chat |
| Migrate brain.md | Dashboard → Memory tab → Migrate | Dashboard UI |
| Compact keeper | Dashboard → Memory tab → Compact | Dashboard UI |
| CLI search | `crew memory "query"` | CLI (crew-cli/) |
| CLI stats | `crew memory-stats` | CLI (crew-cli/) |
| Check availability | `node -e "import('./lib/memory/shared-adapter.mjs').then(m => console.log(m.isSharedMemoryAvailable()))"` | Terminal |

---

## Summary

**Before:** CLI and main CrewSwarm had separate memory systems — no sharing.

**After:** Unified shared memory root (`~/.crewswarm/shared-memory/`) accessed by all agents, CLIs, and sessions via `lib/memory/shared-adapter.mjs` → `crew-cli/dist/crew.mjs`.

**Result:** Every agent can recall what every other agent did. CLI bypass works seamlessly — user can start a task in Cursor, continue in CLI, hand off to dashboard chat, and all agents see the full context.

**Storage:** Three layers (AgentKeeper = task results, AgentMemory = cognitive facts, Collections = docs RAG) unified by MemoryBroker's lexical search + relevance ranking.

**Performance:** Fast (<100ms retrieval), auto-compacting, prefix-cached in chat sessions.

**Commands:** `@@MEMORY search|stats`, `@@BRAIN fact`, migration script, dashboard UI.

**Next:** Run `node scripts/migrate-brain-to-shared-memory.mjs` to populate shared memory from existing brain.md files. All agents will immediately have access to the migrated context.
