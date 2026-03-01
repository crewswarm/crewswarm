# BENCHMARK INVESTIGATION SUMMARY
## Date: 2026-03-01

## What We Tried:

### 1. Baby Task Test ("Write JWT validator")
- ✅ All 5 stacks worked
- ✅ 100/100 quality score
- ❌ BUT: Cost showed $0.00000 (not tracking real costs)
- ❌ BUT: Only tested L1→L2→L3 single path
- ❌ BUT: No multi-agent orchestration
- ❌ BUT: Task was too trivial (300 lines)

### 2. Complex Roadmap Task
- ❌ Hung after >300s with no output
- ❌ Process died silently
- ❌ Cannot reproduce reliably

### 3. Real Multi-Agent Task (VS Code Extension)
- ❌ Hangs at `Pipeline.execute()` call
- ❌ No logger output from L2 orchestration
- ❌ Process stuck waiting for Grok API response
- ❌ 50-220+ seconds with zero progress

---

## ROOT CAUSE IDENTIFIED:

### The Hang is at L2 Orchestration:

```
User Task
  ↓
Pipeline.execute() called ← WE GET HERE
  ↓
l2Orchestrate() called ← HANGS HERE
  ↓
executor.execute() → Grok API ← WAITING FOREVER
  ↓
[NO RESPONSE OR TIMEOUT]
```

### Why No Output?

The `UnifiedPipeline` class uses `Logger` but:
1. **Doesn't log before LLM calls** - No "Calling Grok..." message
2. **Doesn't log API requests/responses** - No visibility into what's sent/received
3. **Doesn't log L2 decision steps** - Can't see routing logic
4. **Doesn't show progress** - User has no idea what's happening

---

## WHAT'S NEEDED FOR REAL BENCHMARKING:

### 1. Add Verbose Logging to Pipeline:

```typescript
// In unified.ts l2Orchestrate():
console.log(`🔄 L2: Routing decision for: "${request.userInput.substring(0, 60)}..."`);
console.log(`🔄 L2: Calling ${this.executor.getModel()} with prompt (${composedPrompt.finalPrompt.length} chars)...`);

const result = await this.executor.execute(...);

console.log(`✅ L2: Got response (${result.result.length} chars)`);
console.log(`✅ L2: Decision = ${decision.decision}`);
```

### 2. Add Timeout Handling:

```typescript
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error('L2 orchestration timeout')), 60000)
);

const result = await Promise.race([
  this.executor.execute(...),
  timeoutPromise
]);
```

### 3. Add Cost Tracking:

Currently `totalCost` is hardcoded to `0.0001` for routing. Need REAL API cost calculation.

### 4. Show LLM Exchange Details:

```
📤 SENT TO GROK (grok-4-1-fast-reasoning):
   Prompt: "User request: Build VS Code extension..."
   Length: 2,450 chars
   Temperature: 0.3
   Max tokens: 1000

📥 RECEIVED FROM GROK:
   Response: '{"decision":"execute-parallel","reasoning":...'
   Length: 1,823 chars
   Tokens: 520 in / 456 out
   Cost: $0.0012
   Time: 3.2s
```

---

## WHY THE HANG HAPPENS:

### Theory 1: Grok API Rate Limiting
- Multiple tests hit Grok API quickly
- Rate limit triggered, API stops responding
- No error returned, just infinite wait

### Theory 2: Prompt Too Long
- VS Code extension task = very detailed
- Grok context limit = 128K tokens
- Prompt may exceed limit → API hangs

### Theory 3: Network Timeout Not Set
- `fetch()` call to Grok has no timeout
- If API is slow/dead, waits forever
- Node doesn't have default timeout

---

## RECOMMENDED FIX:

### Short Term (For This Benchmark):
1. Use SIMPLER task (not full VS Code extension)
2. Add 60s timeout to all LLM calls
3. Add console.log before/after each API call
4. Test with just 1 stack (not 3 back-to-back)

### Long Term (For Production):
1. Add comprehensive logging to `UnifiedPipeline`
2. Add request/response interceptor to `LocalExecutor`
3. Show progress UI in REPL
4. Add `/trace` detailed view
5. Implement proper cost tracking per API call

---

## ALTERNATIVE BENCHMARK APPROACH:

Instead of using `UnifiedPipeline` directly, use the **PM Loop** from `PM-LOOP-REALWORLD-TEST.md`:

```bash
# Create ROADMAP.md with VS Code extension tasks
PM_PROJECT_ID=vscode-bench \
PM_ROADMAP_FILE=./test-roadmap.md \
PM_MAX_ITEMS=10 \
node pm-loop.mjs
```

**Benefits:**
- ✅ Already has progress logging
- ✅ Shows each task dispatch
- ✅ Updates roadmap with [x] marks
- ✅ Has retry/timeout logic
- ✅ Real multi-agent orchestration (PM → Coder → QA)
- ✅ Can see exactly what each agent produces

---

## CONCLUSION:

**We CANNOT benchmark the pipeline properly without:**
1. Verbose logging showing each LLM call
2. Timeout handling to prevent infinite hangs
3. Real cost tracking per API call
4. Progress indicators

**The pipeline WORKS for simple tasks but HANGS on complex ones** because:
- Grok API is slow/rate-limited for complex prompts
- No visibility into what's happening
- No timeout protection

**RECOMMENDATION:** Either:
A) Fix the logging/timeout issues first, OR
B) Use PM Loop for benchmarking (it already has these features)
