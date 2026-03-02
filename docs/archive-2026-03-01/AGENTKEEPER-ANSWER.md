# 🎯 Answer: Cross-System Memory for Your Use Case

## Your Question
> "Is this memory between CLI and main gateway/RT agents or just CLI? Would we use with our CLI bypass when we have 1 project to easily share memories between Cursor/Claude/Codex/OpenCode and our main crew-lead agent / Gemini?"

## Short Answer: **YES!** ✅

**Currently**: CLI-only (same process)  
**With 1-line .env change**: Cursor + Claude + Codex + CLI + Gateway + Crew-Lead + Gemini all share memory

## How to Enable (2 Minutes)

### Step 1: Add to `.env`
```bash
CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
```

### Step 2: Done!
All agents now read/write the **same file**:
```
/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory/.crew/agent-memory/crew-lead.json
```

## What This Gives You

### ✅ Cursor → CLI
```typescript
// In Cursor
memory.remember('Budget: $50k, Use React', { critical: true });

// In CLI (automatic)
$ npm run crew -- build app
// CLI sees: "Budget: $50k, Use React" (from Cursor!)
```

### ✅ CLI → Gateway
```typescript
// CLI stores L2 decision
memory.remember('L2 Decision: execute-parallel');

// Gateway reads it
memory.recall() // Gets: "L2 Decision: execute-parallel"
```

### ✅ Claude → Gemini
```typescript
// Claude reviews code
memory.remember('Code review: Fix TypeScript types');

// Gemini (Crew-Lead) uses it
memory.recall() // Gets: "Code review: Fix TypeScript types"
```

### ✅ All Agents Collaborate
```
Cursor:  "Budget $50k, Deadline March 15"
   ↓
CLI:     Reads budget, plans task accordingly
   ↓
Gateway: Shows CLI progress to user
   ↓
Claude:  Reviews code with budget constraint
   ↓
Gemini:  Coordinates crew with full context
```

## Perfect for Your "CLI Bypass" Workflow

```
User in Cursor
   ↓
Cursor stores preferences (budget, tech stack, deadlines)
   ↓
CLI bypasses re-asking user (reads from Cursor memory)
   ↓
Crew-Lead Agent (Gemini) sees both Cursor + CLI context
   ↓
All workers execute with shared memory
   ↓
Gateway shows real-time progress from CLI
   ↓
Claude reviews with full project context
```

## File Structure

```
/Users/jeffhobbs/Desktop/CrewSwarm/
│
├── .env
│   └── CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
│
├── shared-memory/  ← ALL agents write here
│   └── .crew/
│       └── agent-memory/
│           └── crew-lead.json  ← Shared by everyone!
│
├── crew-cli/       ← Reads/writes crew-lead.json
├── crew-gateway/   ← Reads/writes crew-lead.json
└── crew-rt/        ← Reads/writes crew-lead.json
```

## Example Memory File

**File**: `shared-memory/.crew/agent-memory/crew-lead.json`

```json
{
  "agentId": "crew-lead",
  "facts": [
    {
      "content": "Budget: $50k, Deadline: March 15",
      "provider": "cursor",
      "critical": true
    },
    {
      "content": "L2 Decision: execute-parallel",
      "provider": "cli-pipeline",
      "critical": true
    },
    {
      "content": "Task status: 60% complete",
      "provider": "gateway",
      "critical": false
    },
    {
      "content": "Code review: TypeScript fixes needed",
      "provider": "claude",
      "critical": false
    }
  ]
}
```

## Benefits

1. **No Re-Asking**: Cursor sets budget once, CLI knows forever
2. **Seamless Handoff**: Claude reviews → Gemini applies fixes
3. **Crash Recovery**: CLI crashes → Restart continues from L2 decision
4. **Cross-Model**: Start DeepSeek → Switch Gemini → Context preserved
5. **Audit Trail**: Full history of who decided what, when

## Current Limitations

⚠️ **File-based**: All agents must share filesystem (same machine)  
⚠️ **No locking**: Race conditions possible if simultaneous writes  
⚠️ **No real-time**: Agent A writes, Agent B sees on next `recall()` (not instant pub/sub)

## Upgrade Path (Future)

### Phase 1: File-Based (Now) ✅
- Set `CREW_MEMORY_DIR` in `.env`
- Works for single machine
- Good for local development

### Phase 2: Redis (30 minutes)
```bash
brew install redis
redis-server

# .env
REDIS_URL=redis://localhost:6379
```
- ✅ Network access (CLI on laptop, Gateway on server)
- ✅ Atomic operations (no race conditions)
- ✅ Pub/sub for real-time updates

### Phase 3: HTTP API (1 hour)
```bash
POST http://memory-service.local/api/memory/crew-lead/remember
GET  http://memory-service.local/api/memory/crew-lead/recall
```
- ✅ Works across internet
- ✅ REST API for any language
- ✅ Can add auth, rate limiting

## Documentation

- 📖 `AGENTKEEPER-INTEGRATION.md` - Full API guide
- 🏗️ `AGENTKEEPER-ARCHITECTURE.md` - Visual architecture
- 🎯 `AGENTKEEPER-YOUR-USECASE.md` - Detailed diagrams for your workflow
- 🌐 `AGENTKEEPER-CROSS-SYSTEM.md` - Cross-system setup guide
- ❓ `AGENTKEEPER-FAQ.md` - This file

---

## TL;DR

**Question**: Can Cursor/Claude/Codex/CLI/Gateway/Gemini share memory?  
**Answer**: **YES!** Add `CREW_MEMORY_DIR=/path/to/shared` to `.env`  
**Setup**: 2 minutes  
**Result**: All agents see same context, no re-asking user preferences
