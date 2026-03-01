# Execution Flow Deep Dive

## What ACTUALLY Happens When You Send a Task

### The Real Flow (Not Theoretical)

```
User: "Build auth system with tests"

┌─────────────────────────────────────────────────────────────────┐
│ L1: CHAT INTERFACE (No execution, just intent capture)         │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2: ROUTER (LLM Call #1 - Decision Making)                     │
│                                                                  │
│ Input: "Build auth system with tests"                           │
│ Output: {                                                        │
│   "decision": "execute-parallel",  ← Complex task detected      │
│   "reasoning": "Multi-step, needs QA",                          │
│   "estimatedCost": 0.025                                        │
│ }                                                                │
│                                                                  │
│ Cost: $0.001 | Time: 2s                                         │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼ (IF CREW_DUAL_L2_ENABLED=true)
┌─────────────────────────────────────────────────────────────────┐
│ L2A: DECOMPOSER (LLM Call #2 - Task Breakdown)                 │
│                                                                  │
│ Input: Task + context                                           │
│ Output: {                                                        │
│   "units": [                                                     │
│     {                                                            │
│       "id": "auth-endpoints",                                    │
│       "description": "Create login/register endpoints",          │
│       "requiredPersona": "executor-code",                        │
│       "dependencies": []                                         │
│     },                                                           │
│     {                                                            │
│       "id": "write-tests",                                       │
│       "description": "Write integration tests",                  │
│       "requiredPersona": "specialist-qa",                        │
│       "dependencies": ["auth-endpoints"]                         │
│     }                                                            │
│   ]                                                              │
│ }                                                                │
│                                                                  │
│ Cost: $0.003 | Time: 3s                                         │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2B: POLICY VALIDATOR (LLM Call #3 - Risk Check)               │
│                                                                  │
│ Input: Work graph from L2A                                      │
│ Output: {                                                        │
│   "approved": true,                                              │
│   "riskLevel": "medium",                                         │
│   "concerns": [                                                  │
│     "Requires file system writes",                               │
│     "Estimated cost: $0.024"                                     │
│   ],                                                             │
│   "recommendations": [                                           │
│     "Review code before apply",                                  │
│     "Use sandbox"                                                │
│   ]                                                              │
│ }                                                                │
│                                                                  │
│ HARD GATES CHECKED:                                              │
│   ✓ Cost < $0.50                                                │
│   ✓ Risk != critical                                            │
│   ✓ Approved = true                                             │
│                                                                  │
│ Cost: $0.002 | Time: 2s                                         │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ L3: PARALLEL EXECUTORS (LLM Calls #4-5 - Actual Work)          │
│                                                                  │
│ Batch 1 (no dependencies):                                      │
│   └─ executor-code: Build auth endpoints                        │
│      Input: Work unit description + composed prompt             │
│      Output: [Auth code implementation]                         │
│      Cost: $0.010 | Time: 8s                                    │
│                                                                  │
│ Batch 2 (depends on Batch 1):                                   │
│   └─ specialist-qa: Write tests                                 │
│      Input: Auth code + test requirements                       │
│      Output: [Test suite]                                       │
│      Cost: $0.008 | Time: 6s                                    │
│                                                                  │
│ Total: 2 LLM calls in sequence | Cost: $0.018 | Time: 14s      │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2: SYNTHESIZE RESULTS                                          │
│                                                                  │
│ Combine outputs from all executors into coherent response       │
│ Add execution summary with costs and paths                      │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ L1: PRESENT TO USER                                             │
│                                                                  │
│ Response: "Built auth system with 3 endpoints and test suite"   │
│ Files changed: src/auth.js, tests/auth.test.js                  │
│ Cost: $0.024                                                     │
│ Path: l1 → l2 → l2a → l2b → l3 (2 executors) → l1              │
│                                                                  │
│ NEXT: /preview to review, /apply to write                       │
└─────────────────────────────────────────────────────────────────┘

Total LLM Calls: 5 (1 router + 1 decomposer + 1 validator + 2 executors)
Total Cost: $0.024
Total Time: 21s
```

## Approval Flow: When Does User Get Asked?

### Currently Implemented:

**Automatic (No Approval Needed)**:
1. Simple questions (CHAT path)
2. Single-file code edits < $0.05
3. Read-only operations

**Soft Approval (Warning + Proceed)**:
4. Medium complexity ($0.05-0.20)
5. Multi-file changes

**Hard Gate (BLOCKS Until Approval)**:
6. Cost > $0.50
7. Risk = CRITICAL
8. File deletion operations
9. External API calls

### User Interaction Points:

```typescript
// Point 1: After routing decision
if (plan.estimatedCost > 0.10) {
  console.log(`⚠️  Estimated cost: $${plan.estimatedCost}`);
  console.log(`   Type /approve to continue or Ctrl+C to cancel`);
  // Wait for /approve command
}

// Point 2: After validation
if (validation.riskLevel === 'high') {
  console.log(`⚠️  HIGH RISK detected:`);
  validation.concerns.forEach(c => console.log(`   - ${c}`));
  console.log(`   Type /approve-risk to continue`);
  // Wait for approval
}

// Point 3: Before applying to disk
console.log(`\n  ✓ 3 files changed in sandbox`);
console.log(`  Type /preview to review or /apply to write to disk`);
// User controls when changes hit filesystem
```

## Does LLM Keep Feeding Things?

**NO** - This is NOT an iterative loop like Cursor Composer. Here's how it differs:

### Current Implementation (Execute Once):
```
User Request → L2 Plans → L3 Executes → Return Result → DONE
```

### What Cursor/Gemini CLI Does (Iterative):
```
User Request → LLM Action 1 → See Result → LLM Action 2 → See Result → ...
                    ↑                                                    │
                    └────────────────────────────────────────────────────┘
```

### To Enable Iterative Mode:

```typescript
// Add to UnifiedPipeline
async executeIterative(request: L1Request, maxIterations: number = 5) {
  let iteration = 0;
  let context = request.context || '';
  
  while (iteration < maxIterations) {
    const result = await this.execute({
      ...request,
      context: context + `\n\nIteration ${iteration}. Previous results: ...`
    });
    
    // Check if task complete
    if (result.response.includes('COMPLETE') || result.response.includes('DONE')) {
      return result;
    }
    
    // Feed result back as context
    context += `\n\n[Iteration ${iteration} Result]:\n${result.response}`;
    iteration++;
  }
  
  throw new Error('Max iterations reached without completion');
}
```

## Compare: Direct Gemini CLI vs Our Stack

| Feature | Direct Gemini CLI | Our 3-Tier Stack |
|---------|------------------|------------------|
| **Routing** | None (one model does all) | Explicit L2 router |
| **Planning** | Implicit | Explicit L2A/L2B |
| **Cost Control** | None | Hard gates at L2 |
| **Risk Validation** | None | L2B policy check |
| **Parallel Execution** | Sequential only | True parallel L3 |
| **Trace** | None | Full `/trace` |
| **Model Selection** | Fixed | Per-tier choice |
| **Approval Gates** | None | Configurable |
| **Iteration** | Built-in | Optional add-on |

## Testing This For Real

Run the benchmark script:

```bash
# Set up all keys
export XAI_API_KEY="your-key"
export GEMINI_API_KEY="your-key"
export DEEPSEEK_API_KEY="your-key"

# Run benchmark
cd crew-cli
node scripts/benchmark-stack.mjs

# Results show:
# - Actual costs per tier
# - Real execution times
# - Quality scores
# - Success rates
```

## Bottom Line

**Current State**: Execute-once model (plan → validate → execute → done)
**Not Yet**: Iterative feedback loop (execute → observe → adjust → execute)

**To match Gemini CLI iterative behavior**: Add the `executeIterative()` method above.

**Approval happens**: At decision points with user commands (`/approve`, `/preview`, `/apply`)

**LLM doesn't keep running**: It stops after execution, waits for user action.
