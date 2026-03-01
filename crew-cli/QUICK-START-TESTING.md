# Stack Configuration & Testing - Quick Start

## Your Questions Answered

### ✅ Can we set the stack to all Grok/Gemini/DeepSeek?
**YES** - Use environment variables:

```bash
# All Grok (x.ai)
export CREW_ROUTING_ORDER="grok,grok,grok"

# All Gemini
export CREW_ROUTING_ORDER="gemini,gemini,gemini"

# All DeepSeek
export CREW_ROUTING_ORDER="deepseek,deepseek,deepseek"

# Mixed (recommended)
export CREW_ROUTING_ORDER="grok,deepseek,gemini"
```

Or use interactive configuration in REPL:
```bash
crew repl
crew(manual)> /stack
```

### ✅ Can we test them directly (like Gemini CLI)?
**YES** - Direct LLM test script included:

```bash
cd crew-cli
node scripts/test-direct-llm.mjs
```

Tests each provider (Grok, Gemini, DeepSeek) with same 3 tasks:
- Simple question
- Medium code task  
- Complex roadmap

Shows baseline cost/time/quality **without** the 3-tier pipeline.

### ✅ How does it work - does LLM keep feeding things?
**NO** - Current implementation is **execute-once**:

```
User Request → L2 Plans → L3 Executes → Return Result → DONE
```

**NOT** like Cursor/Gemini CLI iterative loop:
```
Request → Execute → Observe → Adjust → Execute → ... (loop)
```

See `EXECUTION-FLOW.md` for how to add iterative mode if needed.

### ✅ Does it take roadmap, break down to phases, then pass to router?
**Almost - it goes L2A → L2B → L3:**

```
User: "Build auth system"
  ↓
L2 Router: Classifies as "execute-parallel"
  ↓
L2A Decomposer: Breaks into work units with dependencies
  Output: [auth-endpoints] → [jwt-validation] → [tests]
  ↓
L2B Validator: Checks cost/risk, enforces gates
  Output: Approved (if under limits)
  ↓
L3 Executors: Run work units in parallel batches
  Batch 1: [auth-endpoints, jwt-validation]
  Batch 2: [tests]  (after Batch 1 completes)
  ↓
L2 Synthesize: Combine results
  ↓
L1 Present: Show to user in sandbox
```

### ✅ What is logic to come back to user to approve?
**Three approval gates:**

1. **Gate #1: Cost** (before planning)
   - Triggers if `estimatedCost > CREW_COST_LIMIT` (default $0.50)
   - Blocks until user types `y` or `n`

2. **Gate #2: Risk** (after validation)
   - Triggers if `riskLevel === 'critical'`
   - Blocks until user types `y` or `n`

3. **Gate #3: Files** (always)
   - Changes staged in sandbox (not disk)
   - User types `/preview` to review
   - User types `/apply` to write to disk

See `APPROVAL-FLOW.md` for complete flow diagram.

## Quick Test Commands

### 1. Run Full Benchmark Suite
```bash
cd crew-cli

# Set your API keys
export XAI_API_KEY="your-key"
export GEMINI_API_KEY="your-key"  
export DEEPSEEK_API_KEY="your-key"

# Run everything
./scripts/run-benchmarks.sh
```

This runs:
- **Test 1**: Direct LLM baseline (no pipeline)
- **Test 2**: 3-tier stack with 4 configurations
  - all-grok
  - all-gemini
  - all-deepseek
  - optimal-mix

### 2. Configure Your Stack
```bash
# Option A: Environment variables
export CREW_ROUTING_ORDER="grok,deepseek,gemini"
export CREW_DUAL_L2_ENABLED="true"
export CREW_COST_LIMIT="0.50"
export CREW_ALLOW_CRITICAL="false"

# Option B: Interactive in REPL
crew repl
crew(manual)> /stack
```

### 3. Test Real Workflow
```bash
crew repl

# Try these commands:
crew(manual)> /mode builder
crew(builder)> write me a REST API endpoint for user login
crew(builder)> /trace          # See execution path
crew(builder)> /preview         # Review changes
crew(builder)> /apply           # Write to disk
```

## Key Documents

| Document | Purpose |
|----------|---------|
| `TESTING-GUIDE.md` | Complete testing & benchmarking guide |
| `EXECUTION-FLOW.md` | Detailed flow diagrams with LLM calls |
| `APPROVAL-FLOW.md` | User approval gates & interaction |
| `ARCHITECTURE-STANDALONE.md` | 3-tier architecture overview |
| `PIPELINE-UNIFIED.md` | Technical pipeline implementation |
| `PROMPT-COMPOSITION.md` | Dynamic prompt system |

## Expected Results

### Direct LLM (Baseline)
```
Gemini: $0.000 (free), 3.5s avg, good for simple tasks
DeepSeek: $0.0008, 4.2s avg, best cost/quality ratio
Grok: $0.0015, 2.8s avg, fastest but most expensive
```

### 3-Tier Stack
```
Simple tasks: +$0.0001 overhead (routing), similar time
Medium tasks: +$0.003 overhead, similar time
Complex tasks: +$0.008 overhead, -40% time (parallelization)

WINS:
- Cost control (hard gates)
- Risk validation
- Parallel execution
- Specialized personas
- Full traceability

LOSES:
- Simple Q&A (overhead not worth it)
```

## Next Steps

1. **Run benchmarks** to see actual performance
2. **Configure stack** based on your cost/quality needs
3. **Test in REPL** with real tasks
4. **Review traces** to understand execution
5. **Adjust gates** based on your workflow

## Configuration Examples

### Maximum Cost Efficiency
```bash
export CREW_ROUTING_ORDER="gemini,deepseek"
export CREW_DUAL_L2_ENABLED="false"
export CREW_COST_LIMIT="0.10"
```

### Maximum Quality
```bash
export CREW_ROUTING_ORDER="grok,grok,grok"
export CREW_DUAL_L2_ENABLED="true"
export CREW_COST_LIMIT="2.00"
```

### Balanced (Recommended)
```bash
export CREW_ROUTING_ORDER="grok,deepseek,gemini"
export CREW_DUAL_L2_ENABLED="true"
export CREW_COST_LIMIT="0.50"
```

## Troubleshooting

**Benchmark fails with API errors?**
- Check API keys are set: `echo $XAI_API_KEY`
- Verify keys are valid: `curl -H "Authorization: Bearer $XAI_API_KEY" https://api.x.ai/v1/models`

**3-tier stack not using configured providers?**
- Check `CREW_ROUTING_ORDER` format: comma-separated, no spaces
- Verify spelling: `grok`, `gemini`, `deepseek` (lowercase)

**Cost gates not triggering?**
- Check `CREW_COST_LIMIT` is set: `echo $CREW_COST_LIMIT`
- Try a lower limit to test: `export CREW_COST_LIMIT="0.01"`

**Changes not appearing in sandbox?**
- Check you're in builder/orchestrator mode, not manual
- Run `/info` to see current configuration
