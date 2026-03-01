# Unified 3-Tier Pipeline Architecture

## The Clean Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     L1: CHAT INTERFACE                          │
│  (REPL/CLI - User interaction, clarifications, responses only)  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│             L2: ROUTER + REASONER + PLANNER                     │
│  Unified orchestration layer - single decision point            │
│                                                                  │
│  1. Classify request (DIRECT / EXECUTE-LOCAL / EXECUTE-PARALLEL)│
│  2. Build execution plan (if complex)                           │
│  3. Validate safety/cost/policy                                 │
│  4. Decide standalone vs gateway                                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  L3: PARALLEL EXECUTORS                         │
│  Specialized workers run tasks concurrently                     │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Executor │  │ Executor │  │ Executor │  │Specialist│       │
│  │  Code    │  │  Chat    │  │    PM    │  │    QA    │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│       │             │              │              │             │
│       └─────────────┴──────────────┴──────────────┘             │
│                           │                                     │
│                   Synthesize Results                            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
                   Return to L1
```

## Request Flow

### Example 1: Simple Question

```
User: "What's the best way to handle auth?"

L1 → L2 Router:
  Decision: DIRECT-ANSWER
  Reasoning: Simple technical question
  
L2 → Response:
  "Use JWT tokens with httpOnly cookies..."
  Cost: $0.0001

Total Path: L1 → L2 (direct)
```

### Example 2: Single Task

```
User: "Write a REST API for users"

L1 → L2 Router:
  Decision: EXECUTE-LOCAL
  Reasoning: Single coding task, no specialists needed
  
L2 → L3 Single Executor:
  Persona: executor-code
  Output: [REST API code]
  Cost: $0.005

Total Path: L1 → L2 → L3 (single)
```

### Example 3: Complex Multi-Step

```
User: "Build auth system with tests and security review"

L1 → L2 Router:
  Decision: EXECUTE-PARALLEL
  Reasoning: Complex, requires multiple specialists
  
L2 → Dual-L2 Planner:
  L2A Decomposer:
    - Unit 1: Build auth endpoints (executor-code)
    - Unit 2: Write tests (specialist-qa)
    - Unit 3: Security audit (specialist-security)
  
  L2B Policy Validator:
    ✓ Approved
    Risk: medium
    Cost: $0.025
    
L2 → L3 Parallel Execution:
  Batch 1: Unit 1 (no dependencies)
  Batch 2: Unit 2, Unit 3 (depend on Unit 1)
  
  Synthesize results → Combined response
  Cost: $0.024

Total Path: L1 → L2 → L2A → L2B → L3 (parallel)
```

## Key Design Principles

### 1. Single Decision Point (L2)

**Before** (Broken):
```
CLI Router → crew-main → Gateway → Another Router → Agent
   ↓            ↓           ↓            ↓            ↓
Prompt 1    Prompt 2    Prompt 3     Prompt 4    Prompt 5
```

**After** (Clean):
```
L1 (UI) → L2 (Unified Orchestrator) → L3 (Executors)
   ↓              ↓                        ↓
No logic    Single decision         Execute only
```

### 2. Prompt Contract Alignment

All prompts come from the **same registry** with **controlled overlays**:

- Router uses: `router-v1` + task + context
- Executor uses: `executor-code-v1` + task + context + safety
- Planner uses: `decomposer-v1` + task + context + constraints

**No more fragmentation** between CLI prompt, crew-main prompt, and agent prompts.

### 3. Explicit Execution Paths

Every request has ONE of these paths:

1. **Direct Answer**: L1 → L2 → L1
2. **Single Executor**: L1 → L2 → L3 (single) → L1
3. **Parallel Execution**: L1 → L2 → L2A → L2B → L3 (parallel) → L1

### 4. Capability-Based Routing

L2 checks capabilities before routing to L3:

```typescript
if (workUnit.requiredCapabilities.includes('file-write')) {
  if (!hasCapability(persona, 'file-write')) {
    throw new Error('Persona lacks file-write capability');
  }
}
```

### 5. Cost & Risk Gates

L2 validates before execution:

```typescript
if (plan.estimatedCost > 0.50) {
  // Request approval or simplify plan
}

if (validation.riskLevel === 'critical') {
  // Block or require explicit approval
}
```

## Standalone vs Gateway Mode

### Standalone Mode (Default)

```
L1 → L2 → L3 (Local Executors)
```

All execution happens locally using Grok/Gemini/DeepSeek directly.
- No gateway dependency
- Works offline
- 90% of use cases

### Gateway Mode (Optional)

```
L1 → L2 → L3 (Gateway Specialists)
```

Only when complex multi-agent coordination needed:
- crew-qa for testing
- crew-pm for roadmaps
- crew-security for audits
- crew-github for git operations

**Gateway is Tier 3, not required for Tier 2!**

## Configuration

### Enable Unified Pipeline

```bash
# Default behavior - always uses unified pipeline
crew repl

# Or explicitly set
export CREW_PIPELINE_MODE="unified"  # unified | legacy
```

### Configure L2 Behavior

```bash
crew(manual)> /stack

? L2 Mode: (Use arrow keys)
❯ Simple (direct routing, no dual-L2)
  Smart (with dual-L2 for complex tasks)
  Always Parallel (force L2A/L2B for everything)
```

### View Execution Path

```bash
crew(manual)> build me a REST API
[L1 → L2 → L3 (executor-code)]
Response: [Code generated]
Cost: $0.005

crew(manual)> /trace

Trace ID: pipeline-abc123

Execution Path:
  1. l1-interface → received request
  2. l2-orchestrator → decision: execute-local
  3. l3-executor-single → executor-code
  4. l1-interface → returned response

Composed Prompts:
  ├─ router-v1 (1.0.0)
  │  └─ overlays: task, constraints
  └─ executor-code-v1 (1.0.0)
     └─ overlays: task, context

Total Cost: $0.005
Execution Time: 3.2s
```

## Benefits Over Old Architecture

| Old (Broken) | New (Unified) |
|-------------|---------------|
| Multiple routers | Single L2 orchestrator |
| Prompt fragmentation | Unified prompt registry |
| crew-main dependency | Standalone first |
| Gateway required | Gateway optional (Tier 3) |
| Mode confusion | Clear L1/L2/L3 separation |
| Hidden execution paths | Explicit trace |
| No cost control | Cost gates at L2 |
| No risk validation | Policy validator at L2B |
| Sequential only | Parallel execution at L3 |

## Request Types & Routing

### DIRECT-ANSWER (L1 → L2 → L1)

Triggers:
- Greetings ("hi", "hello")
- Status checks ("/status", "how are you")
- Simple questions ("what is X?")
- System queries ("show models")

**No L3 execution needed**

### EXECUTE-LOCAL (L1 → L2 → L3 single)

Triggers:
- "Write code for X"
- "Create a function that Y"
- "Refactor this code"
- "Explain how Z works"

**Single executor, no specialists**

### EXECUTE-PARALLEL (L1 → L2 → L2A → L2B → L3 parallel)

Triggers:
- "Build X with tests and security review"
- "Create a roadmap for Y"
- "Implement feature Z with QA"
- Complex multi-step requests

**Multiple executors in dependency order**

## Traceability

Every request gets:

1. **Trace ID**: Unique identifier
2. **Execution Path**: L1 → L2 → L3 steps
3. **Composed Prompts**: All prompts used with overlays
4. **Cost Breakdown**: Per-step and total
5. **Timing**: Execution duration
6. **Decision Reasoning**: Why L2 chose this path

View with `/trace <traceId>` command.

## Future Enhancements

- [ ] Streaming execution updates (show L3 progress in real-time)
- [ ] Interactive plan approval (show work graph before execution)
- [ ] Cost optimization suggestions (L2 suggests cheaper alternatives)
- [ ] Auto-retry with fallback (if L3 fails, L2 adjusts plan)
- [ ] Learning from failures (store failed paths, avoid in future)
- [ ] Persona marketplace (custom L3 executors)

## Migration from Old Architecture

### Before

```typescript
// Old way - unclear routing
const route = await orchestrator.route(task);
if (route.decision === 'CODE') {
  await router.dispatch('crew-coder', task);
}
```

### After

```typescript
// New way - unified pipeline
const pipeline = new UnifiedPipeline();
const result = await pipeline.execute({
  userInput: task,
  context: repoContext,
  sessionId: session.id
});

console.log(result.response);
console.log(`Path: ${result.executionPath.join(' → ')}`);
console.log(`Cost: $${result.totalCost.toFixed(4)}`);
```

## Files

- `src/pipeline/unified.ts` - Unified pipeline implementation
- `src/prompts/registry.ts` - Prompt templates & capabilities
- `src/prompts/dual-l2.ts` - L2A/L2B planner
- `src/executor/local.ts` - Local L3 executors
- `PIPELINE-UNIFIED.md` - This document

## Summary

**One Request Path. One Decision Point. Clear Tiers.**

- L1 = Chat interface (UI only)
- L2 = Router + Reasoner + Planner (single orchestration layer)
- L3 = Parallel executors (specialized workers)

No more mode confusion. No more prompt fragmentation. No more crew-main dependency.

Gateway is **optional** Tier 3, not required infrastructure.

All requests flow through **one unified pipeline** with **full traceability**.
