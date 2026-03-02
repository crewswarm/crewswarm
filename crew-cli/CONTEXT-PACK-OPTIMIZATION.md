# Context Pack Optimization - Before/After Comparison

## Test Configuration

### v1 (Baseline - My Initial Test):
```bash
# Default settings (no explicit context budget)
OUTPUT_DIR="/Users/jeffhobbs/Desktop/benchmark-vscode-grok-WRITE-QA"
# Context pack existed but may not have been optimally tuned
```

### v2 (Optimized - Your Settings):
```bash
export CREW_CONTEXT_BUDGET_CHARS=5000    # Down from ~7000 default
export CREW_CONTEXT_MAX_CHUNKS=6         # Explicit limit
export CREW_CONTEXT_PACK_TTL_HOURS=24    # Cache for reuse
OUTPUT_DIR="/Users/jeffhobbs/Desktop/benchmark-vscode-grok-WRITE-QA-v2"
```

## Expected Improvements

### 1. **Token Spend Reduction**
**Why:** Tighter budget (5000 chars) means even less context per worker

**v1 Estimate:**
- Average ~3,000 chars artifact context per worker
- 12 workers × 3,000 = 36,000 chars (~9,000 tokens)

**v2 Target:**
- Average ~2,000 chars artifact context per worker (5000 char budget)
- 12 workers × 2,000 = 24,000 chars (~6,000 tokens)
- **Savings: 12,000 chars (~3,000 tokens, ~$0.006)**

### 2. **Faster L3 Execution**
**Why:** Smaller prompts = faster API calls

**v1:** 390s total L3 time across 10 workers
- Average: 39s per worker

**v2 Target:** ~320s total (18% faster)
- Average: ~27s per worker
- **Time savings: 70s**

### 3. **Better QA Convergence**
**Why:** Structured outputs make QA/fixer prompts cleaner

**v1:** 3 QA rounds
- Round 1: 9 issues
- Round 2: 6 issues  
- Round 3: 5 issues
- **Total QA cost: $0.041**

**v2 Target:** Potentially 2 rounds if fixes are more precise
- Round 1: 7 issues (better initial quality)
- Round 2: 3 issues
- Round 3: 1-0 issues (approval)
- **Target QA cost: $0.030 (27% reduction)**

## Metrics to Compare

### Cost Breakdown:
```
v1:
├── Pipeline generation: $0.078
├── Materialization: $0.010
└── QA + Fixer: $0.041
Total: $0.129

v2 Target:
├── Pipeline generation: $0.072 (-8%)
├── Materialization: $0.010 (same)
└── QA + Fixer: $0.030 (-27%)
Total: $0.112 (-13%)
```

### Time Breakdown:
```
v1:
├── L2 Planning: 53s
├── L3 Execution: 390s
├── Materialization: 69s
└── QA/Fixer: 195s
Total: 707s

v2 Target:
├── L2 Planning: 53s (same)
├── L3 Execution: 320s (-18%)
├── Materialization: 69s (same)
└── QA/Fixer: 150s (-23%)
Total: 592s (-16%)
```

### Context Stats:
```
v1:
├── Full artifacts size: 6,239 chars (PDD + ROADMAP + ARCH)
├── Average retrieved: ~3,000 chars per worker
├── Context chars saved: ~32,000 total
└── Savings vs naive: 57%

v2 Target:
├── Full artifacts size: ~6,969 chars (slightly larger PDD/ROADMAP)
├── Average retrieved: ~2,000 chars per worker (tighter budget)
├── Context chars saved: ~43,000 total
└── Savings vs naive: 65%
```

## How Context Pack Optimization Works

### Chunk Selection Algorithm:
```typescript
retrieve(packId, {
  query: unit.description,        // "Create webview HTML"
  sourceRefs: unit.sourceRefs,    // ["PDD.md#UI", "ARCH.md"]
  budgetChars: 5000,              // ⬅️ Reduced from 7000
  maxChunks: 6                    // ⬅️ Hard limit
}) {
  // 1. Score chunks
  for (chunk of allChunks) {
    score = 0;
    if (sourceRefs.includes(chunk.source)) score += 100;  // Explicit ref
    for (term of queryTerms) {
      if (chunk.terms.includes(term)) score += 3;         // Relevance
    }
  }
  
  // 2. Sort by score
  sorted = chunks.sortBy(score, DESC);
  
  // 3. Pack until budget exhausted or maxChunks hit
  selected = [];
  charsUsed = 0;
  for (chunk of sorted) {
    if (selected.length >= 6) break;           // ⬅️ Max chunks
    if (charsUsed + chunk.length > 5000) break; // ⬅️ Budget
    selected.push(chunk);
  }
  
  return selected.join('\n\n');
}
```

### Why Tighter Budget Helps:
1. **Forces Prioritization**: Only the MOST relevant chunks make it
2. **Reduces Noise**: Less context = clearer signal for LLM
3. **Faster Processing**: Smaller prompts → faster API calls
4. **Lower Cost**: Fewer input tokens charged

### Trade-off:
- **Risk**: Workers might miss some context
- **Mitigation**: `sourceRefs` ensures critical chunks are included
- **Net**: Quality stays high, cost/time decreases

## What to Look For in v2 Results:

### Success Indicators:
✅ Total cost < $0.115 (vs $0.129 in v1)
✅ Total time < 620s (vs 707s in v1)  
✅ QA converges in 2-3 rounds (same or better)
✅ `context_chars_saved_est` > 40,000
✅ No quality degradation (still 90%+ complete)

### Failure Indicators:
❌ Quality drops (more QA issues per round)
❌ Workers confused due to missing context
❌ More than 3 QA rounds needed
→ If this happens, increase `CREW_CONTEXT_BUDGET_CHARS` to 6000

## Running Test Now...

Check `/tmp/qa-v2-fixed.log` for live progress.

Expected completion: ~10-12 minutes from start.
