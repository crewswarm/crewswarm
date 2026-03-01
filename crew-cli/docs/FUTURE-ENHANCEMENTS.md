# crew-cli Future Enhancements (Optional)

**Status**: Core roadmap is complete; this file tracks optional follow-ons and partials.

---

## High Value (Market Differentiation)

### 1. xAI/Grok Integration ⭐️
**Why**: No official Grok CLI exists - market opportunity  
**What**: Add Grok models to crew-cli routing layer  
**Effort**: 2-3 days  
**Validation**: `crew x-search "what's trending on X?"`

**Implementation checklist**:
- [ ] Add xAI provider to orchestrator
- [ ] Support grok-beta, grok-vision-beta models
- [x] Add X/Twitter search tool integration
- [ ] Add `--provider xai` flag
- [ ] Test multimodal (vision) capabilities
- [x] Document usage in FEATURES.md

---

### 2. Real-World Benchmark ✅ (Delivered 2026-03-01)
**Why**: Validate 72% cost savings + 10x speed claims  
**What**: Run 10-file refactor sequential vs parallel  
**Metrics**: tokens, USD, time, success rate
**Deliverable**: `docs/BENCHMARK-RESULTS.md`

---

### 3. Video Demo ✅ (Delivered 2026-03-01)
**Why**: Marketing + onboarding (show don't tell)  
**What**: 3-5 min demo of parallel execution  
**Deliverable**: `docs/marketing/demo.mp4` + embedded in website

---

## Medium Value (User Experience)

### 4. Semantic Memory Deduplication ✅ (Delivered 2026-03-01)
**Why**: Reduce memory store size by 30-50%  
**What**: Cluster similar entries during compaction  

---

### 5. LSP Auto-Fix Integration ✅ (Delivered 2026-03-01)
**Why**: Type errors caught and fixed automatically  
**What**: After agent edit, run LSP check + auto-fix  
**Validation**: `crew auto "add strict mode" --lsp-auto-fix`

---

### 6. Repository Map Visualization ✅ (Delivered 2026-03-01)
**Why**: Visual graph aids codebase exploration  
**What**: Generate dependency graph output  
**Command**: `crew map --graph`

---

## Priority Rationale

### Why "High Value"?
- **Market differentiation** (Grok CLI doesn't exist)
- **Validation of core claims** (benchmark proves value)
- **User acquisition** (video demo for marketing)

---

## Current Status: Production Ready ✅

**What's complete**:
- ✅ 3-tier architecture (router → planner → workers)
- ✅ Parallel execution (worker pool)
- ✅ AgentKeeper memory (cross-session persistence)
- ✅ Token caching (40% cost reduction)
- ✅ Blast radius (safety gates)
- ✅ Collections search (RAG over docs)
- ✅ Production hardening (failure-safe writes, redaction)
- ✅ Speculative Explore (parallel branches)
- ✅ LSP diagnostics & Autocomplete
- ✅ PTY/Interactive shell support

**Tests**: 91/91 passing (100%)  
**Documentation**: Complete (README, FEATURES, QUICKSTART, OVERVIEW, API)  
**Quality**: Production-grade alpha

---

**Status**: Refer to `/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/ROADMAP.md` for completion state and active backlog.
