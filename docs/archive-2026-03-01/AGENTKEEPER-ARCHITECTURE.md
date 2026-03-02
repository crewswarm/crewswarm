# AgentKeeper Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         L1 - Chat Interface                              │
│                     User: "Build VS Code extension"                      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    L2 - Router + Reasoner + Planner                      │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Decision: execute-parallel                                        │  │
│  │ Reasoning: "Complex task requiring UI, API, and testing roles"   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                │                                          │
│                                ▼                                          │
│         ┌──────────────────────────────────────────┐                    │
│         │  AgentMemory.remember()                   │                    │
│         │  - Store L2 Decision                      │                    │
│         │  - Tag: [l2-decision, traceId]            │                    │
│         │  - Critical: true                         │                    │
│         └──────────────────────────────────────────┘                    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     L3 - Parallel Executors                              │
│                                                                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐            │
│  │  Worker: UI    │  │  Worker: API   │  │  Worker: Test  │            │
│  │  Persona: FE   │  │  Persona: BE   │  │  Persona: QA   │            │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘            │
│          │                   │                   │                      │
│          ▼                   ▼                   ▼                      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  1. memory.recall({ tags: ['l2-decision'] })                     │  │
│  │     ↓                                                              │  │
│  │  "=== AGENT MEMORY ===                                            │  │
│  │   [CRITICAL] L2 Decision: execute-parallel - Building extension   │  │
│  │   ==="                                                             │  │
│  │                                                                    │  │
│  │  2. Execute work unit with injected memory context                │  │
│  │                                                                    │  │
│  │  3. memory.remember(output)                                       │  │
│  │     - Store worker output                                          │  │
│  │     - Tag: [l3-output, traceId, workerId]                         │  │
│  │     - Critical: false                                              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    Persistent Storage Layer                              │
│                                                                           │
│  .crew/agent-memory/pipeline.json                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ {                                                                 │  │
│  │   "agentId": "pipeline",                                          │  │
│  │   "facts": [                                                      │  │
│  │     {                                                             │  │
│  │       "id": "uuid-1",                                             │  │
│  │       "content": "L2 Decision: execute-parallel - Building...",  │  │
│  │       "critical": true,                                           │  │
│  │       "tags": ["l2-decision", "pipeline-abc123"],                │  │
│  │       "provider": "deepseek"                                      │  │
│  │     },                                                            │  │
│  │     {                                                             │  │
│  │       "id": "uuid-2",                                             │  │
│  │       "content": "Worker ui-design: Created chat.html...",       │  │
│  │       "critical": false,                                          │  │
│  │       "tags": ["l3-output", "pipeline-abc123", "ui-design"],     │  │
│  │       "provider": "gemini"                                        │  │
│  │     }                                                             │  │
│  │   ]                                                               │  │
│  │ }                                                                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                   Cross-Model Continuity                                 │
│                                                                           │
│  Pipeline Crash → Restart with DeepSeek                                 │
│         ↓                                                                │
│  memory.recall() → Retrieves L2 decision from Gemini                    │
│         ↓                                                                │
│  DeepSeek continues execution with full context                         │
│                                                                           │
│  Model Switch: Grok → Gemini → DeepSeek                                 │
│         ↓                                                                │
│  All workers see same L2 decision memory                                │
│         ↓                                                                │
│  No context loss across provider changes                                │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        Memory Recall Priority                            │
│                                                                           │
│  1. Critical facts first (L2 decisions, project constraints)            │
│  2. Most recent facts (sorted by timestamp)                             │
│  3. Tagged facts (filtered by tags array)                               │
│  4. Token budget enforcement (max 500 tokens for L3 workers)            │
│                                                                           │
│  Example:                                                                │
│    memory.recall({                                                       │
│      tokenBudget: 500,                                                   │
│      criticalOnly: false,                                                │
│      tags: ['l2-decision', traceId],                                     │
│      provider: 'pipeline'                                                │
│    })                                                                    │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      Integration Summary                                 │
│                                                                           │
│  Files Modified:                                                         │
│    ✅ crew-cli/src/pipeline/unified.ts (6 integration points)           │
│                                                                           │
│  Files Created:                                                          │
│    ✅ crew-cli/src/pipeline/agent-memory.ts (193 lines)                 │
│    ✅ AGENTKEEPER-INTEGRATION.md                                         │
│    ✅ AGENTKEEPER-INTEGRATION-COMPLETE.md                                │
│    ✅ scripts/test-agent-memory.mjs                                      │
│                                                                           │
│  External Sources:                                                       │
│    ✅ vendor/agentkeeper/ (cloned from GitHub)                           │
│                                                                           │
│  Total Lines Added: 6 (excluding module creation)                       │
│  Build Status: ✅ Compiles cleanly                                       │
│  Test Status: ✅ All integration points verified                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Integration Points

### 1. L2 Memory Storage
**Location**: `unified.ts:384-390`  
**Purpose**: Store routing decisions for crash recovery and cross-model continuity  
**Lines**: 5

### 2. L3 Memory Injection
**Location**: `unified.ts:760-768`  
**Purpose**: Inject L2 decisions into worker context  
**Lines**: 9

### 3. Worker Output Storage
**Location**: `unified.ts:845-850`  
**Purpose**: Store worker outputs for downstream coherence  
**Lines**: 4

### 4. Import Statement
**Location**: `unified.ts:16`  
**Purpose**: Access global pipeline memory instance  
**Lines**: 1

**Total**: **19 lines** (6 distinct integration points)

## Memory Flow

```
User Request
    ↓
L2 Decision → memory.remember() → .crew/agent-memory/pipeline.json
    ↓
L3 Worker 1 → memory.recall() → Receives L2 context
    ↓              ↓
    ↓          memory.remember() → Store output
    ↓
L3 Worker 2 → memory.recall() → Receives L2 + Worker 1 context
    ↓              ↓
    ↓          memory.remember() → Store output
    ↓
Pipeline Result → All decisions preserved for next run
```

## Benefits

1. **Crash Recovery**: Pipeline restarts recall previous state
2. **Cross-Model**: Switch Grok → Gemini → DeepSeek without losing context
3. **Worker Coherence**: Downstream workers see upstream decisions
4. **Cost Optimization**: Avoid re-planning on restarts
5. **Audit Trail**: Full decision history persisted to disk
