# Testing & Benchmarking Guide

## What We're Testing

This benchmark suite answers your key questions:

### 1. Can we set the stack to all Grok/Gemini/DeepSeek?
**YES** - Configure via environment:

```bash
# All Grok
export CREW_ROUTING_ORDER="grok,grok"

# All Gemini  
export CREW_ROUTING_ORDER="gemini,gemini"

# All DeepSeek
export CREW_ROUTING_ORDER="deepseek,deepseek"

# Mixed (optimal)
export CREW_ROUTING_ORDER="grok,deepseek,gemini"
```

### 2. Can we test them directly (Gemini CLI style)?
**YES** - Run: `node scripts/test-direct-llm.mjs`

This tests each LLM provider directly (no pipeline) to establish baseline:
- Response quality
- Cost per task
- Time to complete
- Token usage

### 3. How does it work when we send a requirement?
**Depends on complexity:**

**Simple Question** (e.g., "What is JWT?"):
```
User → L2 Router → Direct Answer → User
       (1 LLM call, ~$0.0001, 2s)
```

**Single Code Task** (e.g., "Write JWT validator"):
```
User → L2 Router → L3 Executor → User
       (2 LLM calls, ~$0.005, 5s)
```

**Complex Roadmap** (e.g., "Build auth system"):
```
User → L2 Router → L2A Decomposer → L2B Validator → L3 Parallel Executors → User
       (5+ LLM calls, ~$0.025, 20s)
       
       L2A breaks into work units: [auth-endpoints], [tests], [docs]
       L2B validates cost/risk
       L3 executes in parallel batches based on dependencies
```

### 4. Does LLM keep feeding things (iterative)?
**NO** - Current implementation is **execute-once**:
```
Request → Plan → Execute → Return → DONE
```

**Not yet implemented** (but can be added):
```
Request → Execute → Observe → Adjust → Execute → ...
         ↑                                        │
         └────────────────────────────────────────┘
```

See `EXECUTION-FLOW.md` for iterative mode implementation.

### 5. Does it break down to phases then pass to router?
**Almost - it breaks down AND validates:**

```
L2A Decomposer:
  Input: "Build auth system"
  Output: Work graph with dependencies
    ├─ Unit 1: auth-endpoints (no deps)
    ├─ Unit 2: password-reset (depends on Unit 1)
    └─ Unit 3: tests (depends on Unit 1, 2)

L2B Validator:
  Input: Work graph
  Output: Risk assessment + approval
    ├─ Cost estimate: $0.024
    ├─ Risk level: medium
    └─ Approved: true (if under cost/risk gates)

L3 Executors:
  Batch 1: Unit 1 (parallel)
  Batch 2: Units 2, 3 (parallel, after Batch 1)
```

### 6. What is logic to come back to user to approve?
**3 approval gates:**

**Gate 1: Cost Threshold**
```typescript
if (estimatedCost > $0.50) {
  console.log("⚠️  High cost detected: $0.75");
  console.log("   Type /approve to continue");
  await waitForApproval();
}
```

**Gate 2: Risk Level**
```typescript
if (riskLevel === 'critical') {
  console.log("⚠️  CRITICAL risk: Deletes production files");
  console.log("   Type /approve-risk to continue");
  await waitForApproval();
}
```

**Gate 3: File Changes**
```typescript
// After execution, always sandbox first
console.log("✓ 5 files changed in sandbox");
console.log("  Type /preview to review");
console.log("  Type /apply to write to disk");
// User explicitly controls disk writes
```

**Configure gates:**
```bash
export CREW_COST_LIMIT="1.00"        # Max cost before approval
export CREW_ALLOW_CRITICAL="false"   # Block critical risk
export CREW_AUTO_APPLY="false"       # Require /apply for writes
```

## Running Benchmarks

### Prerequisites
```bash
export XAI_API_KEY="your-grok-key"
export GEMINI_API_KEY="your-gemini-key"
export DEEPSEEK_API_KEY="your-deepseek-key"
```

### Run All Tests
```bash
cd crew-cli
./scripts/run-benchmarks.sh
```

Or run individually:

### Test 1: Direct LLM (Baseline)
```bash
node scripts/test-direct-llm.mjs
```

Tests each provider with same 3 tasks:
- Simple: "What is best auth approach?"
- Medium: "Write JWT validator"
- Complex: "Build auth system roadmap"

**Shows:**
- Raw LLM performance
- No routing overhead
- Single-shot execution
- Cost/time baseline

### Test 2: 3-Tier Stack (Full Pipeline)
```bash
node scripts/benchmark-stack.mjs
```

Tests 4 configurations:
1. `all-grok`: All tiers use Grok
2. `all-gemini`: All tiers use Gemini
3. `all-deepseek`: All tiers use DeepSeek
4. `optimal-mix`: Grok router, DeepSeek executor, Gemini tier3

**Shows:**
- Routing intelligence
- Planning overhead
- Parallel execution gains
- Cost/quality trade-offs

## Interpreting Results

### Direct LLM Results
```
✅ Gemini 2.0 Flash
   Tests passed: 3/3
   Total cost: $0.000 (free tier)
   Avg time: 3500ms
   Total tokens: 15,234
```

### 3-Tier Stack Results
```
📊 OPTIMAL-MIX
   Simple:  $0.0001 | 2s   | 8/10 quality
   Medium:  $0.0050 | 5s   | 9/10 quality
   Complex: $0.0240 | 18s  | 10/10 quality
   
   Total Cost: $0.0291
   Success Rate: 100%
```

### Key Metrics

**Cost Efficiency**: 3-tier may cost more (routing overhead) but provides:
- Better task decomposition
- Risk validation
- Parallel execution
- Cost gates

**Quality**: Multi-tier should score higher on complex tasks due to:
- Specialized personas per work unit
- Explicit planning phase
- QA validation step

**Time**: 3-tier faster on complex tasks due to parallelization:
- Direct: 5 sequential calls = 25s
- 3-tier: 2 router + 3 parallel = 12s

## Expected Outcomes

### When Direct LLM Wins:
- Simple questions
- Single-turn conversations
- Cost-sensitive simple tasks

### When 3-Tier Wins:
- Complex multi-step tasks
- Need for cost/risk control
- Parallel execution benefits
- Specialized expertise needed

## Configuration for Production

Based on benchmark results, set your stack:

```bash
# High quality, moderate cost
export CREW_ROUTING_ORDER="grok,deepseek,gemini"
export CREW_DUAL_L2_ENABLED="true"
export CREW_COST_LIMIT="0.50"

# Maximum cost efficiency
export CREW_ROUTING_ORDER="gemini,deepseek"
export CREW_DUAL_L2_ENABLED="false"
export CREW_COST_LIMIT="0.10"

# Maximum quality, cost no object
export CREW_ROUTING_ORDER="grok,grok,grok"
export CREW_DUAL_L2_ENABLED="true"
export CREW_COST_LIMIT="2.00"
```

## Next Steps

After running benchmarks:

1. Review `EXECUTION-FLOW.md` for implementation details
2. Check `/trace` command output during actual REPL use
3. Adjust cost/risk gates based on your workflow
4. Consider adding iterative mode if needed (see `executeIterative()` in EXECUTION-FLOW.md)
