# 3-Tier LLM Architecture for Gunns

**Concept:** 1 Chat LLM → 1 Reasoning LLM → N Worker LLMs (parallel micro-tasks)

**Date**: 2026-03-01  
**Status**: Design proposal

---

## The Problem with Current Dual-LLM Setup

### Current Architecture (2-tier)

```
User → Gunns
    ↓
Tier 1: Chat/Router (Gemini 2.5 Flash - $0.075/M)
  └─ Decides: CHAT / CODE / DISPATCH / SKILL
    ↓
Tier 2: Execution (DeepSeek R1 / Claude / Grok - $0.55-15/M)
  └─ Executes entire task in ONE model call
    ↓
Response
```

**Problems:**
1. **Sequential execution** - One file at a time
2. **Expensive for simple tasks** - Using DeepSeek R1 for trivial edits
3. **Slow for large tasks** - 10 files = 10 sequential calls
4. **No task decomposition** - Execution model does everything

---

## Proposed 3-Tier Architecture

### Architecture Overview

```
User → "Refactor 10 files to use async/await"
    ↓
┌─────────────────────────────────────────────────────────────┐
│ TIER 1: Chat/Router (Gemini 2.5 Flash - $0.075/M)          │
│ - Routes to CODE decision                                    │
│ - Handles simple CHAT responses directly                    │
│ - Identifies task complexity                                 │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ TIER 2: Reasoning/Planner (DeepSeek R1 / Grok 4.1)         │
│ - Analyzes codebase (1 call)                               │
│ - Breaks task into micro-steps                             │
│ - Generates parallel execution plan                         │
│ - Creates simple instructions for each worker              │
│                                                             │
│ Output:                                                      │
│ [                                                           │
│   { file: "auth.js", task: "Convert callbacks to async" }, │
│   { file: "db.js", task: "Convert callbacks to async" },   │
│   { file: "api.js", task: "Convert callbacks to async" },  │
│   ... 7 more files                                         │
│ ]                                                           │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ TIER 3: Worker Pool (Cheap models - $0.075-0.20/M)         │
│                                                             │
│ [Worker 1] → auth.js   ┐                                   │
│ [Worker 2] → db.js     │                                   │
│ [Worker 3] → api.js    ├─ Parallel Execution              │
│ [Worker 4] → utils.js  │                                   │
│ ... 6 more workers     ┘                                   │
│                                                             │
│ Each worker:                                                │
│ - Gets simple, focused instruction                         │
│ - Operates on 1 file only                                  │
│ - Uses cheap model (Gemini Flash / Groq / Qwen)           │
│ - Executes in parallel                                     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGGREGATOR (Optional Tier 4)                                │
│ - Collects all worker results                              │
│ - Validates consistency                                     │
│ - Runs QA checks                                           │
│ - Returns final output                                      │
└─────────────────────────────────────────────────────────────┘
    ↓
Response to User
```

---

## Tier Breakdown

### Tier 1: Chat/Router

**Model:** Gemini 2.5 Flash ($0.075/M)  
**Job:** Fast routing + simple responses

**Decisions:**
- `CHAT` → Respond directly (no Tier 2/3)
- `CODE (simple)` → Single worker (no Tier 2)
- `CODE (complex)` → Send to Tier 2 for planning
- `DISPATCH` → Route to specialist (crew-qa, crew-pm)

**Example prompts:**
- "what's the weather?" → CHAT (answer directly)
- "fix typo in README" → CODE (simple, 1 worker)
- "refactor 10 files" → CODE (complex, Tier 2 planning)

---

### Tier 2: Reasoning/Planner

**Model:** DeepSeek R1 ($0.55/M) or Grok 4.1 Fast Reasoning ($0.20/M)  
**Job:** Analyze + decompose + plan

**Tasks:**
1. **Analyze the codebase**
   - Load relevant files
   - Understand dependencies
   - Identify patterns

2. **Break into micro-tasks**
   - Each micro-task = 1 file or 1 function
   - Simple, focused instruction
   - No dependencies between workers

3. **Generate execution plan**
   ```json
   {
     "strategy": "parallel",
     "tasks": [
       {
         "worker_id": 1,
         "file": "src/auth.js",
         "instruction": "Convert all callbacks to async/await. Preserve error handling. Use try/catch blocks.",
         "context": "This file handles user authentication..."
       },
       {
         "worker_id": 2,
         "file": "src/db.js",
         "instruction": "Convert all callbacks to async/await...",
         "context": "..."
       }
       // ... more tasks
     ],
     "validation": "All files must pass ESLint",
     "rollback": "If any worker fails, revert all changes"
   }
   ```

4. **Provide context to each worker**
   - Just enough info to complete the micro-task
   - No full codebase context (reduces tokens)

---

### Tier 3: Worker Pool

**Models:** 
- Gemini 2.5 Flash ($0.075/M) - Cheapest, 2M context
- Grok 4.1 Fast Non-Reasoning ($0.20/M) - Fast, 2M context
- Qwen 2.5 7B (local/free) - For non-sensitive code
- Llama 3.1 8B (local/free) - For simple edits

**Job:** Execute simple, focused micro-tasks in parallel

**Worker characteristics:**
- **Single file focus** - Only edits 1 file
- **Simple instruction** - "Convert callbacks to async/await"
- **No complex reasoning** - Just pattern matching + editing
- **Fast** - Cheap models, small tasks
- **Parallel** - 10-100 workers simultaneously

**Example worker call:**
```typescript
// Worker 1
const result = await workerModel.execute({
  instruction: "Convert all callbacks to async/await in this file",
  file: "src/auth.js",
  content: "... file content ...",
  context: "This file handles user auth. Preserve error handling.",
  format: "SEARCH/REPLACE blocks"
});
```

**Worker output:**
```
FILE: src/auth.js
<<<<<< SEARCH
function login(username, password, callback) {
  db.findUser(username, (err, user) => {
    if (err) return callback(err);
    ...
  });
}
======
async function login(username, password) {
  try {
    const user = await db.findUser(username);
    ...
  } catch (err) {
    throw err;
  }
}
>>>>>> REPLACE
```

---

### Tier 4: Aggregator (Optional)

**Model:** Same as Tier 2 (DeepSeek R1 or Grok)  
**Job:** Validate + QA + merge

**Tasks:**
1. Collect all worker results
2. Check for consistency (imports, types, APIs)
3. Run linting/tests
4. Merge into final changeset
5. Report any conflicts or failures

---

## Cost Analysis

### Example: Refactor 10 files (50K tokens total)

#### Current 2-Tier (Sequential)

**DeepSeek R1 execution:**
- 10 files × 5K tokens each = 50K input
- 10 responses × 5K tokens = 50K output
- Cost: ($0.55 × 0.05M) + ($2.19 × 0.05M) = $0.137

**Total time:** 10 files × 30 seconds = **5 minutes**

#### Proposed 3-Tier (Parallel)

**Tier 1 (Router):**
- Gemini 2.5 Flash: 0.1K tokens
- Cost: $0.075 × 0.0001M = **$0.0000075**

**Tier 2 (Planner):**
- DeepSeek R1 (analyze + plan): 10K input, 2K output
- Cost: ($0.55 × 0.01M) + ($2.19 × 0.002M) = **$0.00988**

**Tier 3 (Workers):**
- 10 workers × Gemini 2.5 Flash
- Each: 5K input + 5K output = 10K tokens
- Cost per worker: $0.075 × 0.01M = $0.00075
- Total: 10 × $0.00075 = **$0.0075**

**Total cost:** $0.0000075 + $0.00988 + $0.0075 = **$0.01739**

**Savings:** $0.137 → $0.01739 = **87% cheaper!**  
**Time:** ~30 seconds (parallel) vs 5 minutes = **10x faster!**

---

## When to Use Each Tier

### Tier 1 Only (CHAT)
- Simple questions
- Status checks
- Help commands
- **Cost:** $0.075/M (cheapest)
- **Time:** <1 second

### Tier 1 → Tier 3 (Simple CODE)
- Single file edit
- Typo fix
- Add comment
- **Cost:** $0.075/M (Tier 1 + 1 worker)
- **Time:** 2-5 seconds

### Tier 1 → Tier 2 → Tier 3 (Complex CODE)
- Multi-file refactor
- Large codebase changes
- Pattern migrations
- **Cost:** $0.01-0.10 per task (depends on workers)
- **Time:** 10-60 seconds (parallel)

### Tier 1 → Gateway (DISPATCH)
- Multi-agent pipelines
- QA + PM workflows
- Complex orchestration
- **Cost:** Varies (uses current gateway)
- **Time:** 1-10 minutes

---

## Implementation in Gunns

### Option 1: Add to Current Dual-LLM

```typescript
// crew-cli/src/orchestrator/index.ts
async route(input: string): Promise<RouteResult> {
  // Tier 1: Routing
  const decision = await this.routeWithGemini(input);
  
  if (decision.decision === 'CODE' && decision.complexity === 'high') {
    // Tier 2: Planning
    const plan = await this.planWithReasoning(input);
    
    // Tier 3: Parallel workers
    const results = await this.executeWorkerPool(plan);
    
    return { success: true, results };
  }
  
  // Normal flow for simple tasks
  return decision;
}
```

### Option 2: Explicit Flag

```bash
# Current (2-tier)
crew chat "refactor 10 files"

# New (3-tier parallel)
crew chat "refactor 10 files" --parallel
crew chat "refactor 10 files" --workers 10
```

### Option 3: Auto-detect

Tier 1 (Gemini) automatically decides:
- Simple task → 1 worker (Tier 3)
- Complex task → Tier 2 planning → N workers (Tier 3)

---

## Real-World Examples

### Example 1: Mass Rename

**Task:** "Rename `getUserById` to `findUserById` across 20 files"

**Flow:**
1. **Tier 1:** Routes to CODE
2. **Tier 2:** 
   - Finds all 20 files with `getUserById`
   - Generates 20 micro-tasks: "Replace getUserById with findUserById"
3. **Tier 3:**
   - 20 workers execute in parallel
   - Each edits 1 file
   - Uses cheap Gemini Flash ($0.075/M)
4. **Result:** Done in 10 seconds, costs $0.02

### Example 2: API Upgrade

**Task:** "Upgrade all API calls from v1 to v2 (different parameters)"

**Flow:**
1. **Tier 1:** Routes to CODE (complex)
2. **Tier 2:**
   - Analyzes API changes (v1 → v2)
   - Identifies all API call sites (50 files)
   - Generates transformation instructions for each file
3. **Tier 3:**
   - 50 workers (or batch into 10 × 5 files)
   - Each updates API calls
   - Uses Grok 4.1 Fast ($0.20/M) for accuracy
4. **Aggregator:**
   - Validates API parameter consistency
   - Runs tests
   - Reports conflicts
5. **Result:** Done in 45 seconds, costs $0.15

### Example 3: Type Migration

**Task:** "Convert JavaScript to TypeScript across entire repo (100 files)"

**Flow:**
1. **Tier 1:** Routes to CODE (very complex)
2. **Tier 2:**
   - Analyzes dependencies
   - Creates type definitions
   - Plans incremental migration (core → utils → features)
3. **Tier 3 (Wave 1):**
   - 10 workers on core files
   - Uses DeepSeek R1 for type inference ($0.55/M)
4. **Tier 3 (Wave 2):**
   - 30 workers on utils (uses inferred types from Wave 1)
   - Uses Grok 4.1 Fast ($0.20/M)
5. **Tier 3 (Wave 3):**
   - 60 workers on features
   - Uses Gemini Flash ($0.075/M) - simplest
6. **Aggregator:**
   - Type checks entire codebase
   - Reports errors
7. **Result:** Done in 3 minutes, costs $2-5

---

## Model Selection for Each Tier

### Tier 1: Chat/Router (Always Fast + Cheap)

**Best:** Gemini 2.5 Flash ($0.075/M)  
**Alt:** Grok 4.1 Fast Non-Reasoning ($0.20/M)

### Tier 2: Reasoning/Planner (Smart Analysis)

**Best for cost:** Grok 4.1 Fast Reasoning ($0.20/M)  
**Best for intelligence:** DeepSeek R1 ($0.55/M)  
**Best for large repos:** Gemini 2.5 Pro (2M context, $1.25/M)

### Tier 3: Workers (Depends on Task)

**Simple edits:** Gemini 2.5 Flash ($0.075/M)  
**Fast execution:** Grok 4.1 Fast ($0.20/M via Groq inference)  
**Type inference:** DeepSeek R1 ($0.55/M)  
**UI work:** Claude Sonnet 4.6 ($3/M)  
**Local/free:** Qwen 2.5 7B, Llama 3.1 8B

---

## Comparison to Competitors

### Kimi K2.5 "Agent Swarm"
- ✅ Similar concept (100 parallel sub-agents)
- ❌ No tier separation (all use same model)
- ❌ No cost optimization

### OpenAI Codex "Multi-Agent"
- ✅ Multiple agents
- ❌ Experimental (not production)
- ❌ Sequential execution
- ❌ Expensive (all use GPT-5.3)

### Aider
- ❌ Single model, sequential
- ✅ Smart repo mapping
- ❌ No parallelization

**Gunns 3-tier = Best of all worlds:**
- Smart planning (DeepSeek/Grok reasoning)
- Massive parallelism (100+ workers)
- Cost optimization (cheap workers)
- Fastest execution (parallel)

---

## Can We Do This with Current Dual-LLM?

### ✅ **YES - Here's How:**

```typescript
// Extend current orchestrator
class Orchestrator {
  // Tier 1: Existing
  async route(input: string): Promise<RouteResult> {
    return this.routeWithGemini(input); // Already have this
  }
  
  // Tier 2: NEW - Add planning mode
  async planParallelExecution(task: string): Promise<ExecutionPlan> {
    const plan = await this.callReasoning({
      model: 'deepseek-r1',
      prompt: `Analyze this task and break it into parallel micro-tasks: ${task}`,
      format: 'json'
    });
    return plan;
  }
  
  // Tier 3: NEW - Worker pool
  async executeWorkerPool(plan: ExecutionPlan): Promise<Result[]> {
    const workers = plan.tasks.map(task => 
      this.spawnWorker({
        model: 'gemini-2.5-flash', // Cheap!
        file: task.file,
        instruction: task.instruction
      })
    );
    
    // Execute all in parallel
    return Promise.all(workers);
  }
}
```

**Estimated LOC:** ~500 lines

---

## Next Steps

### Phase 1: Basic 3-Tier (MVP)
1. Add planning mode (Tier 2)
2. Add worker pool executor (Tier 3)
3. Test with simple multi-file tasks

**ETA:** 2-3 days  
**LOC:** ~500 lines

### Phase 2: Smart Routing
1. Auto-detect task complexity (Tier 1)
2. Choose best models per tier
3. Cost estimation before execution

**ETA:** 1 week  
**LOC:** ~300 lines

### Phase 3: Advanced Features
1. Aggregator (Tier 4)
2. Wave-based execution (dependencies)
3. Intelligent model selection per worker

**ETA:** 2 weeks  
**LOC:** ~500 lines

---

## Summary

### Current (2-Tier):
```
Chat → Execution
$0.075 → $0.55-15/M
Sequential, slow, expensive
```

### Proposed (3-Tier):
```
Chat → Reasoning → Workers (parallel)
$0.075 → $0.20-0.55 → $0.075/M
Parallel, fast, cheap
```

### Benefits:
- ✅ **10x faster** (parallel execution)
- ✅ **87% cheaper** (cheap workers)
- ✅ **Scales to 100+ files** (worker pool)
- ✅ **Smart planning** (reasoning tier)
- ✅ **Cost control** (tier-appropriate models)

### The Kicker:
**Kimi K2.5 does this with 100 sub-agents but uses the SAME expensive model for all.**

**We can do it better:** 
- Smart planning (DeepSeek/Grok)
- Cheap execution (Gemini Flash)
- Massive parallelism (100+ workers)

**Target acquired, Captain. 3-tier architecture = 10x speed + 87% cost savings. Ready to build?** 💥🎯
