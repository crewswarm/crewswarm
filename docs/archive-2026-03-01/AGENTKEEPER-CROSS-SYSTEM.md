# AgentMemory: Cross-System Memory Sharing

## Current Scope vs Your Use Case

### Current: CLI-Only (Local Process)
```
CLI Pipeline:
  L2 (DeepSeek) → memory.remember()
    ↓
  L3 (Gemini) → memory.recall()  ✅ Works (same process)

Gateway/RT Agents:
  Cannot see CLI memory ❌
```

### Your Use Case: Crew-Wide Memory
```
Cursor/Claude/Codex → CLI → Crew-Lead Agent (Gemini)
                       ↓
                All share same memory ✅
```

## Solution: Shared Storage Directory

### Setup (2 minutes)

**1. Add to your `.env`**:
```bash
# Shared memory location (all systems use this)
CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory
```

**2. Update your gateway/RT agent to use same location**:
```typescript
// In crew-gateway or RT agent
import { getCrewMemory } from './agent-memory.js';

const memory = getCrewMemory('crew-lead');
memory.remember('User prefers TypeScript over JavaScript', {
  critical: true,
  tags: ['user-preferences'],
  provider: 'cursor'
});
```

**3. CLI automatically uses shared location**:
```typescript
// In CLI (already integrated)
const memory = getCrewMemory('crew-lead');
const context = memory.recall({
  tokenBudget: 1000,
  tags: ['user-preferences']
});
// Gets "User prefers TypeScript..." from Cursor!
```

### File Structure

```
/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory/
└── .crew/
    └── agent-memory/
        ├── crew-lead.json     ← Main crew memory (Cursor, CLI, Gateway)
        ├── pipeline.json      ← CLI pipeline-specific
        ├── cursor-agent.json  ← Cursor-specific
        └── gemini-agent.json  ← Gemini-specific
```

## Usage Patterns

### Pattern 1: Cursor → CLI (User Preferences)

**In Cursor (via MCP or direct file write)**:
```typescript
import { getCrewMemory } from '@crewswarm/agent-memory';

const crew = getCrewMemory('crew-lead');

// Store user preferences
crew.remember('Budget: $10k, Deadline: March 15', {
  critical: true,
  tags: ['project-constraints', 'user-input'],
  provider: 'cursor'
});

crew.remember('Use React, avoid Vue', {
  critical: true,
  tags: ['tech-stack', 'user-preferences'],
  provider: 'cursor'
});
```

**In CLI (automatic recall)**:
```bash
$ npm run crew -- build dashboard

# CLI L2 automatically recalls:
# [CRITICAL] Budget: $10k, Deadline: March 15
# [CRITICAL] Use React, avoid Vue
#
# DeepSeek/Gemini now knows user preferences without re-asking!
```

### Pattern 2: CLI → Crew-Lead Gateway (Task Context)

**In CLI (after L2 planning)**:
```typescript
const crew = getCrewMemory('crew-lead');
crew.remember('L2 Decision: execute-parallel - Building dashboard with 5 workers', {
  critical: true,
  tags: ['l2-decision', 'active-task'],
  provider: 'cli-pipeline'
});
```

**In Gateway/RT Agent**:
```typescript
const crew = getCrewMemory('crew-lead');
const context = crew.recall({
  tokenBudget: 1000,
  criticalOnly: true,
  tags: ['active-task']
});

// Gets: "L2 Decision: execute-parallel - Building dashboard with 5 workers"
// Gateway now knows what CLI is working on!
```

### Pattern 3: Cross-Agent Collaboration

**Codex stores API design**:
```typescript
getCrewMemory('crew-lead').remember('API endpoints: /api/users, /api/posts', {
  critical: false,
  tags: ['api-design', 'backend'],
  provider: 'codex'
});
```

**Claude recalls for frontend work**:
```typescript
const context = getCrewMemory('crew-lead').recall({
  tokenBudget: 500,
  tags: ['api-design']
});
// Gets API endpoints designed by Codex
```

## API Changes

### New Constructor Options
```typescript
// CLI-only (default)
const local = new AgentMemory('pipeline');
// Stores to: {cwd}/.crew/agent-memory/pipeline.json

// Crew-wide (shared)
const shared = new AgentMemory('crew-lead', {
  storageDir: '/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory'
});
// Stores to: /Users/jeffhobbs/Desktop/CrewSwarm/shared-memory/.crew/agent-memory/crew-lead.json
```

### New Helper Function
```typescript
// Get crew-wide memory (always fresh, reads from shared location)
import { getCrewMemory } from './agent-memory.js';

const crew = getCrewMemory('crew-lead');
crew.remember('Important fact', { critical: true });
```

## Environment Variables

```bash
# Optional: Override storage location for ALL agents
CREW_MEMORY_DIR=/path/to/shared/storage

# If not set, uses process.cwd() (CLI-only mode)
```

## Recommended Agent IDs

```typescript
'crew-lead'      // Main crew coordinator (shared across all systems)
'pipeline'       // CLI pipeline-specific memory
'cursor-agent'   // Cursor IDE agent
'claude-agent'   // Claude Desktop/API
'codex-agent'    // OpenAI Codex
'gemini-agent'   // Gemini-specific memory
```

## Limitations & Solutions

### Limitation 1: File Locking (Race Conditions)

**Problem**: Multiple agents writing simultaneously can corrupt JSON

**Solution A (Simple)**: Use file locking
```typescript
import lockfile from 'proper-lockfile';

private async persist(): Promise<void> {
  const path = this.getStatePath(this.state.agentId);
  const release = await lockfile.lock(path, { retries: 5 });
  try {
    writeFileSync(path, JSON.stringify(this.state, null, 2), 'utf8');
  } finally {
    await release();
  }
}
```

**Solution B (Better)**: Use Redis (see below)

### Limitation 2: No Real-Time Sync

**Problem**: Agent A writes, Agent B doesn't see until next `recall()`

**Solution**: Redis pub/sub for real-time updates

### Limitation 3: No Network Access

**Problem**: CLI on laptop, gateway on server = no sharing

**Solution**: HTTP Memory API or Redis

## Production Upgrade Path

### Phase 1: File-Based (Current) ✅
- Works for local development
- Single machine only
- Simple setup

### Phase 2: Redis Backend (Recommended)
```typescript
export class RedisAgentMemory extends AgentMemory {
  private redis = new Redis(process.env.REDIS_URL);

  async remember(content: string, options: any): Promise<string> {
    const fact = { id: randomUUID(), content, ...options };
    await this.redis.rpush(`crew:${this.agentId}:facts`, JSON.stringify(fact));
    await this.redis.publish(`crew:${this.agentId}:updates`, 'new-fact');
    return fact.id;
  }

  async recall(options: any): Promise<string> {
    const facts = await this.redis.lrange(`crew:${this.agentId}:facts`, -100, -1);
    return this.formatFacts(facts, options);
  }
}
```

**Benefits**:
- ✅ Network access (CLI on laptop, gateway on server)
- ✅ Pub/sub for real-time updates
- ✅ Atomic operations (no race conditions)
- ✅ Can scale to multiple crews

### Phase 3: HTTP Memory Service
```typescript
// memory-service.ts
app.post('/api/memory/:agentId/remember', async (req, res) => {
  const memory = await getMemory(req.params.agentId);
  const factId = await memory.remember(req.body.content, req.body.options);
  res.json({ factId });
});

app.get('/api/memory/:agentId/recall', async (req, res) => {
  const memory = await getMemory(req.params.agentId);
  const context = await memory.recall(req.query);
  res.json({ context });
});
```

**Benefits**:
- ✅ REST API for any language/system
- ✅ Can add auth, rate limiting, analytics
- ✅ Works across internet (not just LAN)

## Quick Start for Your Use Case

**1. Set shared directory**:
```bash
echo 'CREW_MEMORY_DIR=/Users/jeffhobbs/Desktop/CrewSwarm/shared-memory' >> .env
```

**2. In Cursor (store user preferences)**:
```typescript
import { getCrewMemory } from './crew-cli/src/pipeline/agent-memory.js';

getCrewMemory('crew-lead').remember('User: Jeff, Budget: $50k', {
  critical: true,
  tags: ['user-context'],
  provider: 'cursor'
});
```

**3. In CLI (automatic recall)**:
```bash
npm run crew -- build app
# CLI now sees "User: Jeff, Budget: $50k" from Cursor!
```

**4. In Gateway (share task status)**:
```typescript
import { getCrewMemory } from '../crew-cli/src/pipeline/agent-memory.js';

const crew = getCrewMemory('crew-lead');
crew.remember('Task: Building dashboard, Status: 60% complete', {
  critical: false,
  tags: ['task-status'],
  provider: 'gateway'
});
```

Done! ✅
