# CrewSwarm Harness Improvements — Based on Industry Research

**Date:** 2026-03-01  
**Sources:** Anthropic, Cursor, Manus, LangChain harness engineering research  
**Goal:** Improve token efficiency, context quality, and agent performance

---

## Phase 1: Progressive Memory Disclosure ✅ (Implementing Now)

**Current State:**
- `recallMemoryContext()` already uses query-based retrieval (good!)
- Fixed `maxResults: 5` cap per call
- All three memory layers searched in parallel (AgentKeeper, AgentMemory, Collections)

**Problems:**
- No adaptive scaling based on task complexity
- Critical facts don't get priority injection
- No session-level memory budget tracking
- Observation compression missing (AgentKeeper can inject 800+ line results)

**Changes:**

### 1.1 Adaptive Result Limits (Immediate)
```javascript
// gateway-bridge.mjs line 787
// Before: maxResults: 5 (fixed)
// After: Scale by task complexity

const taskTokens = taskText.split(/\s+/).length;
const maxResults = taskTokens < 50 ? 3    // Simple: "write hello.js"
                 : taskTokens < 150 ? 5   // Medium: "build auth endpoint with JWT"
                 : 8;                     // Complex: multi-paragraph requirements

sharedMemoryContext = await recallMemoryContext(dir, taskText, {
  maxResults,
  includeDocs: true,
  includeCode: false,
  preferSuccessful: true,
  crewId: agentId || 'crew-lead'
});
```

**Expected Impact:** 30-40% token reduction on simple tasks, better context on complex ones

### 1.2 Critical Facts Priority Injection (High Priority)
```typescript
// crew-cli/src/memory/broker.ts line 106
// Boost critical facts by 0.1 → change to 0.3
// Ensure critical facts always appear in top N

private scoreFacts(query: string, facts: MemoryFact[], max: number): BrokerHit[] {
  const queryTokens = tokenize(query);
  const scored = facts.map(f => {
    const sim = similarity(queryTokens, tokenize(f.content));
    const criticalBoost = f.critical ? 0.3 : 0;  // was 0.1
    const tagBoost = f.tags.some(t => query.toLowerCase().includes(t.toLowerCase())) ? 0.15 : 0;
    return { fact: f, score: sim + criticalBoost + tagBoost };
  }).filter(x => x.score > 0.08);  // lower threshold to catch critical facts

  // Force critical facts into top results even if similarity is low
  scored.sort((a, b) => {
    if (a.fact.critical && !b.fact.critical) return -1;
    if (!a.fact.critical && b.fact.critical) return 1;
    return b.score - a.score;
  });
  
  return scored.slice(0, max).map(x => mapFactHit(x.fact, x.score));
}
```

**Expected Impact:** Security constraints, architectural decisions always visible

### 1.3 AgentKeeper Observation Compression (Medium Priority)
```typescript
// crew-cli/src/memory/agentkeeper.ts
// Add compression for old results

function compressOldResults(entries: KeeperEntry[], keepFullCount: number = 5): KeeperEntry[] {
  // Keep last N full, compress older ones
  const sorted = entries.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  
  return sorted.map((entry, idx) => {
    if (idx < keepFullCount) return entry;  // Keep recent full
    
    // Compress older: keep first 200 chars + success marker
    const preview = entry.result.slice(0, 200);
    const hasError = /error|failed|exception/i.test(entry.result);
    return {
      ...entry,
      result: `${preview}... [${hasError ? '❌ failed' : '✓ completed'}]`
    };
  });
}
```

**Expected Impact:** 70-90% reduction in AgentKeeper context size for long-running sessions

---

## Phase 2: Lazy Skill Loading (High Impact)

**Current State:**
- All 44+ skills listed in system prompt with full descriptions
- Skill content loaded only when `@@SKILL` is called (already good!)
- Dashboard Skills tab shows all skills

**Problems:**
- System prompt bloat: ~200-400 tokens per agent just listing skills
- Irrelevant skills clutter agent's "tool palette"
- No per-agent skill relevance filtering

**Changes:**

### 2.1 Skill Metadata Only in System Prompt
```typescript
// gateway-bridge.mjs system prompt injection
// Before: Full description + params for every skill
// After: Name + one-line summary only

Available skills (use @@SKILL <name> {params}):
- code-review: Structured code quality checklist
- api-design: REST/GraphQL design patterns
- threat-model: OWASP security analysis
... (44 total, ~50 tokens vs ~400 tokens)

Full skill content loaded on-demand when you call @@SKILL.
```

### 2.2 Per-Agent Skill Filtering
```javascript
// Only show relevant skills per agent role
const AGENT_SKILL_GROUPS = {
  'crew-coder': ['code-review', 'api-design', 'test-strategy'],
  'crew-security': ['threat-model', 'code-review'],
  'crew-pm': ['roadmap-planning', 'epic-breakdown-advisor'],
  // ... etc
};

const relevantSkills = AGENT_SKILL_GROUPS[agentId] || allSkills.slice(0, 10);
```

**Expected Impact:** 40-60% reduction in system prompt skill overhead

---

## Phase 3: Tool Definition Optimization (Medium Impact)

**Current State:**
- All ~18 CrewSwarm tools defined in every system prompt
- Tool descriptions are verbose (good for clarity, bad for tokens)
- No MCP lazy loading yet

**Changes:**

### 3.1 Compress Tool Descriptions
```javascript
// Before (verbose):
@@READ_FILE <path>
Reads a file from the filesystem. Use this when you need to see file contents.
Returns the full file text or an error if the file doesn't exist.

// After (compressed):
@@READ_FILE <path> — Read file contents

// Full docs available in agent-prompts.json as fallback
```

### 3.2 MCP Lazy Loading (Already Planned by Cursor)
```typescript
// Create ~/.crewswarm/mcp-tools/ folder structure
// Each MCP server gets a subfolder with tool.json files
// System prompt shows only:

MCP Tools available in mcp-tools/<server>/
Use @@READ_FILE to see tool definitions before calling.
```

**Expected Impact:** 30-40% token reduction on agents using many MCP servers

---

## Phase 4: Architecture Simplification (Long-Term)

**Research Finding:** "If your harness is getting more complex while models get better, something is wrong." - Manus

**Current Complexity Inventory:**
- 20 agents (crew-coder, crew-coder-front, crew-coder-back, crew-frontend, etc.)
- 4 engine backends (OpenCode, Cursor CLI, Claude Code, Codex)
- 2 memory systems (AgentMemory facts + AgentKeeper results)
- 44+ skills
- RT message bus for coordination
- PM loop orchestration
- Ouroboros-style LLM↔Engine loop

**Simplification Candidates:**

### 4.1 Agent Consolidation (Research Needed)
**Question:** Do we need separate crew-coder-front and crew-coder-back?

**Test:**
- Run 20 coding tasks through unified `crew-coder` (Sonnet 4)
- Run same 20 through specialized agents
- Compare: correctness, token usage, latency

**If unified performs ≥90% as well:** Merge specialists

**Expected Savings:** 
- 6 fewer agent processes
- Simpler routing logic
- Reduced system prompt duplication

### 4.2 Skill → MCP Migration
**Question:** Should skills be MCP tools instead?

**Pros:**
- Industry standard (Cursor, Claude Code both use MCP)
- Better IDE integration
- Unified tool calling interface

**Cons:**
- Skills include playbooks/checklists (not just API calls)
- MCP requires server processes (complexity)
- Migration cost

**Decision:** Keep both. API skills → MCP candidates. Knowledge skills stay as SKILL.md.

### 4.3 RT Bus vs HTTP Polling
**Question:** Is WebSocket RT bus overkill?

**Analysis:**
- Pro RT: Real-time task updates, agent working indicators
- Con RT: Connection management, reconnection logic, auth complexity
- HTTP alternative: Dashboard polls `/api/tasks/<id>` every 2s

**Decision:** Keep RT bus. Real-time updates are valuable UX, and connection logic is already stable.

### 4.4 Ouroboros Loop Simplification
**Current:** LLM decomposes task → Engine executes steps → Loop until DONE

**Research Finding:** Cursor uses this for complex reasoning. LangChain doesn't mention it.

**Decision:** Keep but make opt-in per agent (already implemented via `opencodeLoop: true`).

---

## Phase 5: Self-Verification Loop (High Value)

**Research Finding:** LangChain 52.8% → 66.5% with build-verify loop

**Current State:**
- Agents write code, mark tasks done, move on
- No mandatory self-test before completion
- QA agent is optional PM loop gate

**Changes:**

### 5.1 Pre-Completion Verification Hook
```javascript
// gateway-bridge.mjs after tool execution loop completes
// Before agent says "done", inject:

if (taskContainsCodeChanges && !agentRanTests) {
  appendToContext(`
  ⚠️ VERIFICATION REQUIRED
  You wrote code but didn't run tests. Before marking complete:
  1. Run the code/app
  2. Test the specific feature you built
  3. Compare output against the original task spec
  4. Fix any issues found
  
  Reply with test results before saying done.
  `);
  continueLoop = true;
}
```

### 5.2 Task Spec Injection
```javascript
// Keep original task in context even after 50+ tool calls
// Append before final "done" check:

ORIGINAL TASK:
${originalTaskText}

Does your implementation match ALL requirements above?
```

**Expected Impact:** 10-15% improvement in first-try success rate

---

## Phase 6: Context Budgeting (Medium Priority)

**Research Finding:** Cursor tracks time budgets, LangChain uses reasoning sandwiches

**Changes:**

### 6.1 Token Budget Warnings
```javascript
// gateway-bridge.mjs in main loop
const MAX_CONTEXT_TOKENS = 100000;  // model-specific
const currentTokens = estimateTokenCount(contextHistory);

if (currentTokens > MAX_CONTEXT_TOKENS * 0.7) {
  appendWarning(`⏰ Context: ${currentTokens.toLocaleString()} tokens used (70% of limit). Prioritize completing current work.`);
}
```

### 6.2 Adaptive Reasoning Budget
```javascript
// For reasoning models (o1, deepseek-r1)
const REASONING_MODES = {
  planning: 'xhigh',       // Understand problem fully
  implementation: 'high',  // Normal coding
  verification: 'xhigh'    // Catch mistakes
};

// Set per task phase
```

---

## Implementation Priority

### Week 1 (Immediate)
- ✅ CLI usage limit errors (DONE)
- [ ] Adaptive memory result limits (Phase 1.1)
- [ ] Critical facts priority boost (Phase 1.2)
- [ ] AgentKeeper compression (Phase 1.3)

**Expected ROI:** 40-60% token reduction on typical tasks

### Week 2 (High Impact)
- [ ] Lazy skill loading (Phase 2.1, 2.2)
- [ ] Tool description compression (Phase 3.1)
- [ ] Pre-completion verification hook (Phase 5.1)

**Expected ROI:** Additional 30% token reduction, 10-15% quality improvement

### Week 3-4 (Medium Priority)
- [ ] MCP lazy loading (Phase 3.2)
- [ ] Token budget warnings (Phase 6.1)
- [ ] Task spec persistence (Phase 5.2)

### Month 2+ (Research & Architecture)
- [ ] Agent consolidation tests (Phase 4.1)
- [ ] Skill→MCP migration analysis (Phase 4.2)
- [ ] Self-learning from traces (Advanced)

---

## Success Metrics

Track before/after for each phase:

1. **Token Efficiency**
   - Avg tokens per task completion
   - Memory injection overhead
   - System prompt size

2. **Task Quality**
   - First-try success rate
   - Bug rate in completed code
   - User "try again" frequency

3. **Latency**
   - Time to first response
   - Total task completion time
   - KV-cache hit rate (if measurable)

4. **Cost**
   - $ per task
   - $ per 1000 tasks
   - Cost breakdown by agent

---

## Research Questions to Validate

1. **Does agent specialization still matter with Sonnet 4+?**
   - Run A/B test: unified vs specialized coders
   - Measure: correctness, tokens, time

2. **What's our optimal memory result count?**
   - Test: 3, 5, 8, 12 results per query
   - Measure: task success vs token cost

3. **Do we have too many skills?**
   - Analyze usage logs: which skills are called <1% of the time?
   - Candidate for removal or consolidation

4. **Is the RT bus providing measurable value?**
   - User survey: how often do you watch real-time updates?
   - Alternative: faster HTTP polling + SSE for live updates

---

## Anti-Patterns to Avoid

Based on research findings:

1. ❌ **Don't hide errors** - Keep failed attempts in context
2. ❌ **Don't one-shot complex tasks** - Break into incremental steps
3. ❌ **Don't remove tools dynamically** - Use logit masking instead
4. ❌ **Don't compress irreversibly** - Make compression restorable (URLs, file paths)
5. ❌ **Don't trust agent "I'm done"** - Verify before accepting completion

---

**Next Step:** Implement Phase 1 (Progressive Memory Disclosure) now.
