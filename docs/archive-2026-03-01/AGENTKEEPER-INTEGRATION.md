# AgentKeeper Integration

## Overview

AgentKeeper provides **cross-model memory continuity** for the CrewSwarm pipeline. It stores critical facts, L2 decisions, and L3 worker outputs in a persistent cognitive state that survives model switches and pipeline restarts.

## Python Source

Original AgentKeeper: `./vendor/agentkeeper/`

Source: https://github.com/Thinklanceai/agentkeeper

## TypeScript Implementation

Location: `crew-cli/src/pipeline/agent-memory.ts`

### Key Features

1. **Critical Fact Prioritization** - Tag facts as `critical` for guaranteed inclusion in context
2. **Token Budget Management** - Respects token limits when recalling memory
3. **Provider-Agnostic** - Memory persists across Grok, Gemini, DeepSeek, etc.
4. **Tag-Based Filtering** - Query facts by tags (e.g., `l2-decision`, `l3-output`)
5. **Automatic Storage** - Persists to `.crew/agent-memory/<agentId>.json`

## Integration Points (15 lines)

### 1. Import (unified.ts:16)
```typescript
import { getPipelineMemory } from './agent-memory.js';
```

### 2. Store L2 Decisions (unified.ts:384-390)
```typescript
const memory = getPipelineMemory();
memory.remember(`L2 Decision: ${plan.decision} - ${plan.reasoning || 'direct execution'}`, {
  critical: true,
  tags: ['l2-decision', traceId],
  provider: 'pipeline'
});
```

### 3. Inject Memory into L3 Workers (unified.ts:760-768)
```typescript
const memory = getPipelineMemory();
const memoryContext = memory.recall({
  tokenBudget: 500,
  tags: ['l2-decision', traceId],
  provider: 'pipeline'
});
if (memoryContext) {
  overlays.push({ type: 'context', content: memoryContext, priority: 0 });
}
```

### 4. Store Worker Outputs (unified.ts:845-850)
```typescript
const memory = getPipelineMemory();
memory.remember(
  `Worker ${unit.id} (${unit.requiredPersona}): ${parsed.output.substring(0, 300)}...`,
  { critical: false, tags: ['l3-output', traceId, unit.id], provider: 'pipeline' }
);
```

## Usage Example

```typescript
import { AgentMemory } from './pipeline/agent-memory.js';

const agent = new AgentMemory('my-worker-id');

// Remember critical facts
agent.remember('Budget: $50k, Client: Acme Corp', {
  critical: true,
  tags: ['project-context'],
  provider: 'gemini'
});

// Recall memory with budget
const context = agent.recall({
  tokenBudget: 1000,
  criticalOnly: false,
  tags: ['project-context']
});

// Get stats
const stats = agent.stats();
console.log(`Total facts: ${stats.totalFacts}, Critical: ${stats.criticalFacts}`);
```

## Memory Format

Example stored state (`.crew/agent-memory/pipeline.json`):

```json
{
  "agentId": "pipeline",
  "facts": [
    {
      "id": "a1b2c3d4-...",
      "content": "L2 Decision: execute-parallel - Building VS Code extension",
      "critical": true,
      "timestamp": "2026-03-01T20:15:00.000Z",
      "tags": ["l2-decision", "pipeline-abc123"],
      "provider": "pipeline"
    },
    {
      "id": "e5f6g7h8-...",
      "content": "Worker ui-design (frontend): Created chat.html with modern UI...",
      "critical": false,
      "timestamp": "2026-03-01T20:16:30.000Z",
      "tags": ["l3-output", "pipeline-abc123", "ui-design"],
      "provider": "pipeline"
    }
  ],
  "createdAt": "2026-03-01T20:00:00.000Z",
  "updatedAt": "2026-03-01T20:16:30.000Z"
}
```

## Benefits

1. **Cross-Model Continuity**: Switch from DeepSeek → Gemini without losing context
2. **Crash Recovery**: Pipeline restarts can recall previous L2 decisions
3. **Worker Coherence**: Downstream workers see critical decisions from upstream units
4. **Provider Flexibility**: Memory survives API key rotations, model switches, etc.
5. **Lightweight**: Only ~200 lines, zero external dependencies

## Comparison with Python AgentKeeper

| Feature | Python AgentKeeper | TypeScript Implementation |
|---------|-------------------|---------------------------|
| Cross-Model Memory | ✅ | ✅ |
| Critical Facts | ✅ | ✅ |
| Token Budget | ✅ | ✅ |
| SQLite Persistence | ✅ | JSON file persistence |
| LLM Provider Adapters | ✅ OpenAI, Anthropic, Gemini, Ollama | N/A (uses LocalExecutor) |
| Cognitive Reconstruction | ✅ CRE Engine | Tag-based filtering |

## Future Enhancements

- **SQLite Backend**: For multi-agent concurrent writes
- **Semantic Search**: Use embeddings to retrieve relevant facts
- **Fact Expiration**: TTL for time-sensitive context
- **Inter-Agent Relay**: Combine with Agent Relay for pub/sub memory sync
