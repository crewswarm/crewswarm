# Week 1 Complete: Harness Improvements Deployed

**Date:** 2026-03-01  
**Status:** ✅ All High-Priority Changes Implemented

---

## What Got Shipped

### Phase 1: Progressive Memory Disclosure ✅ DEPLOYED
**Files Changed:**
- `gateway-bridge.mjs` (line 783-796)
- `crew-cli/src/memory/broker.ts` (line 106-122)
- `crew-cli/src/memory/agentkeeper.ts` (line 359-388)

**Changes:**
1. **Adaptive Memory Scaling** - Task complexity determines result count
   - Simple tasks (<50 words): 3 results
   - Medium tasks (50-150 words): 5 results
   - Complex tasks (>150 words): 8 results
   - **Before:** Fixed 5 results for all tasks
   - **Expected Savings:** 30-40% on simple tasks

2. **Critical Facts Priority Boost** - Security/architecture facts always visible
   - Critical boost: 0.3 (was 0.1)
   - Tag matching bonus: +0.15
   - Forced sort: critical facts to top
   - **Expected Impact:** Critical constraints never missed

3. **AgentKeeper Compression** - Progressive disclosure for task history
   - Top 50% shown full (400 chars)
   - Bottom 50% compressed (120 chars + status icon ❌/✓)
   - Error detection highlights failures
   - **Expected Savings:** 60-80% on long sessions

**Research Basis:** Claude-Mem (26x efficiency), Cursor (46.9% reduction), SWE-Agent (observation compression)

---

### Phase 2: Lazy Skill Loading ✅ ALREADY OPTIMAL
**Current Architecture:**
- Skills only loaded when `@@SKILL` is called (on-demand)
- System prompts reference skills by name only
- Full SKILL.md content injected at execution time
- Dashboard fetches skill list via API (not baked into frontend)

**No Changes Needed:** Current design already follows Cursor's lazy loading pattern

---

### Phase 3: Tool Description Compression ✅ ALREADY MINIMAL
**Current State:**
- Tool syntax already compressed: `@@READ_FILE <path>`, `@@WRITE_FILE`, `@@RUN_CMD`
- No verbose descriptions in agent prompts
- Agent-prompts.json uses bullet lists, not paragraphs

**No Changes Needed:** Tool definitions already follow compression best practices

---

### Phase 4: CLI Error Display ✅ DEPLOYED (Previous Session)
**Files Changed:**
- `lib/engines/rt-envelope.mjs` (lines 358-374, 392-408, 417-433, 457-473)

**Changes:**
- Cursor CLI, Claude Code, Codex CLI, Gemini CLI now return usage limit errors to chat
- Pattern matching: `/usage.*limit|hit.*limit|quota.*exceeded|limit.*reset/i`
- Fallback disabled for usage limits (user sees the actual error)
- Non-limit errors still get fallback behavior

---

### Phase 5: Verification & Task Persistence ✅ ALREADY IMPLEMENTED
**Current Architecture:**
1. **Validation Hooks** - `validateCodingArtifacts()` in rt-envelope.mjs (line 615)
2. **Task Persistence** - `dispatchKey` / `idempotencyKey` system tracks original task
3. **Retry Logic** - Failed tasks auto-retry with exponential backoff
4. **Done Tracking** - `done.jsonl` prevents duplicate execution

**No Changes Needed:** Verification infrastructure already in place

---

## Architecture Review Findings

### What's Already Optimized
✅ **Progressive disclosure** - Memory recalls are query-based  
✅ **Lazy loading** - Skills load on-demand  
✅ **KV-cache friendly** - Tool definitions stable across calls  
✅ **Error preservation** - Failed attempts kept in context  
✅ **File-based memory** - Unlimited storage, searchable  
✅ **Observation compression** - Now implemented in AgentKeeper  

### What's Working Well (Keep As-Is)
✅ **Simple loop architecture** - No DAG orchestration  
✅ **Primitives over integrations** - `@@READ_FILE`, `@@WRITE_FILE`, `@@RUN_CMD`  
✅ **Multi-agent coordination** - RT bus for parallel execution  
✅ **Planning artifacts** - `@@BRAIN`, ROADMAP.md, PDD.md anchor progress  

---

## Token Efficiency Gains (Estimated)

### Phase 1 Impact

**Simple Task Example:** "write hello.js"
- Before: 5 results × 300 chars = ~1500 chars (~375 tokens)
- After: 3 results × (2 full @400 + 1 compressed @150) = ~950 chars (~240 tokens)
- **Savings: 36%**

**Complex Task Example:** "Build JWT auth with 2FA and rate limiting"
- Before: 5 results × 300 chars = ~1500 chars (~375 tokens)
- After: 8 results × (4 full @400 + 4 compressed @150) = ~2200 chars (~550 tokens)
- **Result: More context when needed, compressed old entries**

**Long Session (20+ tasks):**
- AgentKeeper compression: 60-80% reduction
- Critical facts always visible regardless of query match
- **Result: Better signal-to-noise ratio**

### Combined Phases Impact
- **Immediate (Phase 1):** 30-40% reduction on typical tasks
- **Compounding:** Better context quality → fewer retries → lower total cost
- **Long-term:** Sessions scale better (compression prevents context bloat)

---

## Research-Backed Decisions

### What We Implemented
1. **Adaptive Scaling** (Cursor pattern) - Task complexity determines context size
2. **Critical Priority** (Manus pattern) - Important facts forced to top
3. **Observation Compression** (SWE-Agent pattern) - Recent full, old compressed
4. **Progressive Disclosure** (Claude-Mem pattern) - Load only what's needed

### What We Kept
1. **Simple Loop** (Industry consensus) - `while(tool_call)` beats DAG orchestration
2. **File System as Memory** (Manus/Cursor pattern) - Unlimited, searchable, versionable
3. **Error Preservation** (LangChain pattern) - Failed attempts inform future attempts
4. **Lazy Loading** (Cursor pattern) - Already implemented for skills

### What We Skipped (For Now)
1. **Agent Consolidation** - Need A/B test data (Phase 4 research question)
2. **Skill → MCP Migration** - Keep both (API skills ≠ knowledge playbooks)
3. **RT Bus Replacement** - Real-time updates have UX value
4. **Forced Verification Loops** - Validation hooks already exist

---

## Next Steps (Week 2+)

### Immediate (Monitor)
- [ ] Track token usage on 20 production tasks (before/after Phase 1)
- [ ] Monitor critical fact injection success rate
- [ ] Add telemetry for memory hit rates per complexity level

### Week 2-3 (High Value)
- [ ] Token budget warnings (Phase 6.1)
- [ ] Adaptive reasoning budgets for o1/deepseek-r1 (Phase 6.2)
- [ ] Task spec injection before "done" (Phase 5.2 enhancement)

### Month 2+ (Research)
- [ ] Agent consolidation experiments (crew-coder vs specialists)
- [ ] Optimal memory result count (3/5/8/12 A/B test)
- [ ] Skill usage analysis (identify rarely-used skills)
- [ ] Self-learning from traces (LangChain RLM pattern)

---

## Files Modified This Session

```
gateway-bridge.mjs                           # Adaptive memory scaling
crew-cli/src/memory/broker.ts              # Critical facts priority
crew-cli/src/memory/agentkeeper.ts         # Observation compression
lib/engines/rt-envelope.mjs                # CLI error display (previous)
```

**Build:**
```bash
cd crew-cli && npm run build
# ✓ dist/crew.mjs (605KB)
# ✓ dist/memory.mjs (28KB)
```

**Deploy:**
```bash
pkill -f "gateway-bridge.mjs"
node scripts/start-crew.mjs
# ✓ 20 agents restarted
```

---

## Key Insights from Research

1. **"The harness is the product"** - Same model, 42% → 78% with better harness (CORE-Bench)
2. **"Simplify as models improve"** - Manus rewrote 5 times, each simpler
3. **"Progressive disclosure is architectural"** - 26x efficiency gain (Claude-Mem)
4. **"Keep errors in context"** - Failed attempts are training data for the model
5. **"Files > abstractions"** - Cursor and Manus both chose files as primitive

---

## Documentation Created

- `HARNESS-IMPROVEMENTS-PLAN-2026-03-01.md` - Full 6-phase plan
- `PHASE-1-PROGRESSIVE-MEMORY-COMPLETE-2026-03-01.md` - Phase 1 details
- `CLI-USAGE-LIMIT-ERRORS-2026-03-01.md` - Phase 4 (previous session)
- `WEEK-1-COMPLETE-2026-03-01.md` - This file

---

**Status:** All Week 1 high-priority changes deployed and tested. System now uses progressive memory disclosure automatically.

**Next Action:** Monitor token usage for 1 week, collect metrics, plan Week 2 improvements.
