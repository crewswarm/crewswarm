# Cross-System Memory Sharing - Quick Answer

## Your Question
> "Is this memory between CLI and main gateway/RT agents or just CLI? Would we use with our CLI bypass when we have 1 project to easily share memories between Cursor/Claude/Codex/OpenCode and our main crew-lead agent / Gemini?"

## Answer: Currently CLI-Only, but 2-Line Fix for Cross-System

### Current State (After Integration)
**✅ Works**: Memory shared within single CLI process across different LLM providers
- DeepSeek L2 decision → Gemini L3 worker ✅
- Grok planning → DeepSeek execution ✅

**❌ Does NOT work**: Memory shared between CLI and Gateway/RT agents
- CLI → Gateway ❌
- Cursor → CLI ❌
- Claude → Crew-Lead Agent ❌

**Why**: Memory stored locally in `.crew/agent-memory/` relative to CLI's working directory

### Fix for Your Use Case (2 minutes)

**Already implemented!** Just set environment variable:

```bash
# Add to .env
CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
```

Now **all systems** (CLI, Gateway, RT agents, Cursor, Claude) store memory in the **same location**:

```
/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory/
└── .crew/
    └── agent-memory/
        └── crew-lead.json  ← Shared by everyone!
```

### How It Works

```typescript
// In CLI
const memory = new AgentMemory('crew-lead');
// Stores to: $CREW_MEMORY_DIR/.crew/agent-memory/crew-lead.json

// In Gateway
const memory = new AgentMemory('crew-lead');
// Reads from: $CREW_MEMORY_DIR/.crew/agent-memory/crew-lead.json
// (same file!)

// In Cursor/Claude/Codex (via MCP or direct Node.js)
const memory = new AgentMemory('crew-lead');
// Reads from: $CREW_MEMORY_DIR/.crew/agent-memory/crew-lead.json
// (same file!)
```

## Usage Example

### Step 1: Cursor stores user preferences

```typescript
// In Cursor (via MCP tool or direct import)
const memory = new AgentMemory('crew-lead');
memory.remember('Budget: $50k, Deadline: March 15, Use React', {
  critical: true,
  tags: ['user-preferences'],
  provider: 'cursor'
});
```

### Step 2: CLI recalls preferences automatically

```bash
$ npm run crew -- build dashboard

# CLI L2 automatically recalls:
# [CRITICAL] Budget: $50k, Deadline: March 15, Use React
# (from Cursor!)
```

### Step 3: Gateway sees CLI progress

```typescript
// In Gateway/RT Agent
const memory = new AgentMemory('crew-lead');
const context = memory.recall({
  tokenBudget: 1000,
  tags: ['l2-decision']
});

// Gets: "L2 Decision: execute-parallel - Building dashboard"
// (from CLI!)
```

### Step 4: All agents collaborate

```
Cursor:  "User prefers TypeScript"
   ↓
CLI:     Recalls preference, uses TypeScript in planning
   ↓
Gateway: Sees CLI progress, updates UI
   ↓
Claude:  Recalls TypeScript preference for code review
   ↓
Gemini:  Uses shared context for crew-lead decisions
```

## File Structure

```
/Users/jeffhobbs/Desktop/CrewSwarm/
├── .env
│   └── CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
│
├── shared-memory/  ← All agents write here
│   └── .crew/
│       └── agent-memory/
│           ├── crew-lead.json    ← Main coordination memory
│           ├── cursor-agent.json ← Cursor-specific
│           ├── claude-agent.json ← Claude-specific
│           └── pipeline.json     ← CLI pipeline-specific
│
├── crew-cli/  ← CLI reads/writes to shared-memory/
├── crew-gateway/  ← Gateway reads/writes to shared-memory/
└── crew-rt/  ← RT agents read/write to shared-memory/
```

## Memory Example

**File**: `shared-memory/.crew/agent-memory/crew-lead.json`

```json
{
  "agentId": "crew-lead",
  "facts": [
    {
      "id": "abc-123",
      "content": "Budget: $50k, Deadline: March 15",
      "critical": true,
      "timestamp": "2026-03-01T20:00:00.000Z",
      "tags": ["user-preferences"],
      "provider": "cursor"
    },
    {
      "id": "def-456",
      "content": "L2 Decision: execute-parallel - Building dashboard",
      "critical": true,
      "timestamp": "2026-03-01T20:05:00.000Z",
      "tags": ["l2-decision", "pipeline-abc"],
      "provider": "cli-pipeline"
    },
    {
      "id": "ghi-789",
      "content": "Worker UI-design: Created dashboard.tsx with React",
      "critical": false,
      "timestamp": "2026-03-01T20:10:00.000Z",
      "tags": ["l3-output", "ui-design"],
      "provider": "gemini"
    }
  ],
  "createdAt": "2026-03-01T20:00:00.000Z",
  "updatedAt": "2026-03-01T20:10:00.000Z"
}
```

## Benefits for Your Use Case

✅ **CLI Bypass with One Project**: All agents see same project context  
✅ **Cursor → Crew-Lead**: User preferences flow automatically  
✅ **Claude → CLI**: Code review decisions inform CLI execution  
✅ **Codex → Gemini**: API designs shared across agents  
✅ **Gateway → CLI**: Task status visible to all systems  

## Limitations (Current File-Based Approach)

⚠️ **No Locking**: If CLI and Gateway write simultaneously, race condition possible  
⚠️ **No Real-Time**: Agent A writes, Agent B sees on next `recall()` (not instant)  
⚠️ **Local Only**: All systems must share filesystem (not for distributed systems)

## Upgrade Path (Production)

### Phase 1: File-Based (Current) ✅
- Set `CREW_MEMORY_DIR` in `.env`
- Works for local development
- Single machine only

### Phase 2: Redis Backend (30 minutes)
```bash
# Install Redis
brew install redis
redis-server

# Update .env
REDIS_URL=redis://localhost:6379
```

**Benefits**:
- ✅ Atomic operations (no race conditions)
- ✅ Pub/sub for real-time updates
- ✅ Network access (CLI on laptop, Gateway on server)
- ✅ Can scale to multiple crews

### Phase 3: HTTP Memory API (1 hour)
```bash
# Memory service endpoint
POST http://memory-service.local/api/memory/crew-lead/remember
GET  http://memory-service.local/api/memory/crew-lead/recall
```

**Benefits**:
- ✅ REST API for any language/system
- ✅ Works across internet (not just LAN)
- ✅ Can add auth, rate limiting, analytics

## Quick Start for Your Use Case

```bash
# 1. Set shared directory
echo 'CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory' >> .env

# 2. Restart CLI
npm run crew -- build app

# 3. In Gateway/RT agents, use same CREW_MEMORY_DIR
# They'll automatically share memory!
```

## Summary

**Current**: CLI-only (same process)  
**With `CREW_MEMORY_DIR`**: Cross-system (CLI + Gateway + Cursor + Claude + Gemini)  
**Setup Time**: 2 minutes (1 line in `.env`)  
**Works For**: Single machine with shared filesystem  
**Upgrade To**: Redis (network access) or HTTP API (distributed)

---

**Answer**: Yes! With `CREW_MEMORY_DIR=/path/to/shared`, all agents (Cursor, Claude, Codex, CLI, Gateway, Crew-Lead, Gemini) share the same memory file. Perfect for your "1 project CLI bypass" use case!
