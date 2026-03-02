# Ralph Loop vs CrewSwarm Self-Improvement

## What is Ralph?

Ralph is an **autonomous loop** that spawns **fresh AI instances** repeatedly until all PRD items complete. Key insight: **each iteration = clean context**.

Based on [Geoffrey Huntley's pattern](https://github.com/snarktank/ralph), popularized by Ryan Carson.

## Ralph's Core Loop

```bash
while [ items_remaining ]; do
  # 1. Spawn FRESH Claude Code/Amp instance
  amp run "Implement next story from prd.json"
  
  # 2. Run quality checks
  npm run typecheck && npm test
  
  # 3. Commit if pass
  git commit -m "Story X complete"
  
  # 4. Update prd.json: passes = true
  
  # 5. Append learnings to progress.txt
  echo "Learned: X pattern works for Y" >> progress.txt
  
  # 6. Exit instance (clean context next time)
done
```

**Memory between iterations:**
- Git history (commits)
- `progress.txt` (append-only learnings)
- `prd.json` (which stories pass/fail)
- `AGENTS.md` (updated after each iteration)

## CrewSwarm's Current Self-Improvement

### PM Loop (Existing)
```javascript
// pm-loop.mjs
while (roadmapHasItems) {
  const nextItem = getNextRoadmapPhase();
  const agent = pickAgent(nextItem);
  
  await dispatchTask(agent, nextItem.task);
  
  if (PM_SELF_EXTEND) {
    // Auto-generate new roadmap items when empty
    await extendRoadmap();
  }
}
```

**Memory:**
- `ROADMAP.md` (task list)
- `memory/brain.md` (shared knowledge)
- AgentKeeper (task results in JSONL)
- Shared memory (`.crew/agent-memory/`)

**Problem:** Agent daemons are **stateful**. They accumulate context across tasks. No clean slate per task.

### Background Consciousness (Existing)
```javascript
// Every 15 minutes (idle only)
if (noPipelinesRunning && BG_CONSCIOUSNESS_ENABLED) {
  const reflection = await callLLM(crew-main, "Read brain.md, suggest next steps");
  
  if (reflection.includes('@@DISPATCH')) {
    dispatch(parseDispatch(reflection));
  }
  
  if (reflection.includes('@@BRAIN')) {
    appendToBrain(reflection);
  }
}
```

**Memory:**
- `memory/brain.md` (accumulated facts)
- `~/.crewswarm/process-status.md` (current status)

**Problem:** Prompts are **static**. When a task fails, retry uses same prompt.

## Key Differences

| Aspect | Ralph | CrewSwarm (Before) | CrewSwarm (After Ralph) |
|--------|-------|-------------------|------------------------|
| **Context** | Fresh per iteration | Stateful daemons | Fresh per task |
| **Memory** | progress.txt + git | brain.md + AgentKeeper | progress.txt + brain.md |
| **Prompts** | Includes learnings | Static | Dynamic with learnings |
| **Checks** | After each story | After pipeline | After each story |
| **Learning** | Explicit in progress.txt | Implicit in brain.md | Both |
| **Failure** | Learn, continue to next | Retry with same prompt | Learn, retry with context |

## What Ralph Does Better

### 1. Clean Context Per Task
```bash
# Ralph
amp run "Task 1"  # Fresh instance, 200k tokens free
# Instance exits
amp run "Task 2"  # Fresh instance again

# CrewSwarm (old)
crew-coder daemon running
  Task 1 → 50k tokens used
  Task 2 → 100k tokens used (context growing)
  Task 3 → 150k tokens used (getting full)
```

**Fix:** Make each CrewSwarm dispatch spawn fresh agent, not reuse daemon.

### 2. Explicit Learning Log
```
# progress.txt (Ralph)
### Iteration 1 - 10:23:45
Task: Add login form
Outcome: SUCCESS
Learnings: The auth context is in src/lib/auth.ts. Always import from there, not direct Supabase calls.

### Iteration 2 - 10:31:22  
Task: Add password reset
Outcome: FAILED (typecheck)
Learnings: Password reset emails use the template in emails/reset.tsx. Update that file too.
```

**CrewSwarm equivalent:**
```javascript
// AgentKeeper records results
{"taskId":"abc","agentId":"crew-coder","status":"success","result":"..."}

// But no explicit "what I learned" field
```

**Fix:** Add `learnings` field to AgentKeeper entries.

### 3. AGENTS.md Updates
Ralph **requires** agents to update `AGENTS.md` after each task:
```markdown
# AGENTS.md

## Authentication
- Auth context lives in `src/lib/auth.ts`
- Never import Supabase directly - always use context
- Password reset emails: `emails/reset.tsx`
```

AI coding tools (Amp, Claude Code, Cursor) **auto-read** AGENTS.md, so future iterations benefit.

**CrewSwarm has this!** We already have `AGENTS.md` and agents can update it. We just need to **enforce** it in the prompt.

### 4. Quality Gates Per Story
```bash
# Ralph - after EACH story
typecheck ✓
tests ✓
commit ✓
next story

# CrewSwarm PM loop - after ENTIRE phase
dispatch crew-coder (5 stories)
dispatch crew-qa (tests all 5)
```

**Fix:** Make PM loop dispatch **one story at a time**, run checks, commit, repeat.

## External Context (From Elvis)

"External context" = business knowledge agents don't have:

### What Elvis's Zoe Has Access To
1. **Obsidian vault**
   - Meeting notes
   - Customer requests
   - Past decisions
   - Why things failed

2. **Production database (read-only)**
   - Current customer configurations
   - Active features
   - Usage patterns

3. **Customer communication history**
   - Support tickets
   - Sales calls
   - Feature requests

4. **Business metrics**
   - MRR, churn, usage
   - What's working/not working

### Why This Matters

**Without external context:**
```
Agent: "I'll add a settings panel for teams"
(Doesn't know: customers already have 3 other settings panels and are confused)
```

**With external context:**
```
Zoe: "Customer mentioned in last week's call they're overwhelmed by settings.
Instead of another panel, consolidate into existing Admin → Settings."

Agent: "Got it, consolidating..."
```

### How CrewSwarm Could Add This

**Option 1: Obsidian Integration**
```javascript
// lib/external-context/obsidian.mjs
export function loadObsidianContext(query) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  
  // Search markdown files
  const notes = searchMarkdownFiles(vaultPath, query);
  
  // Extract relevant snippets
  return notes.map(n => ({
    file: n.path,
    snippet: n.matchedParagraphs,
    date: n.modified
  }));
}

// In chat-handler.mjs
if (isSharedMemoryAvailable()) {
  const obsidianContext = loadObsidianContext(message);
  const memoryContext = await recallMemoryContext(...);
  
  // Merge both into prompt
  const fullContext = mergeContexts(obsidianContext, memoryContext);
}
```

**Option 2: Database Query Tool**
```javascript
// Add to agent tools
@@QUERY_PROD_DB SELECT config FROM users WHERE id = 'customer-123'

// Returns read-only query results
// Agents can see customer state without write access
```

**Option 3: Meeting Notes Sync**
```javascript
// Webhook: Zoom/Cal.com → CrewSwarm
POST /api/meeting-notes
{
  "customer": "Acme Corp",
  "date": "2026-03-01",
  "notes": "Customer wants templates feature...",
  "attendees": ["alice@acme.com"]
}

// Stored in memory/meeting-notes/{customer}/{date}.md
// Agents can read when working on customer features
```

## Implementation: Ralph Loop for CrewSwarm

I just created `scripts/ralph-loop.sh` that:

1. ✅ Reads ROADMAP.md (like prd.json)
2. ✅ Finds next incomplete item (`- [ ] Task`)
3. ✅ Dispatches to crew-coder (fresh instance each time)
4. ✅ Runs quality checks (typecheck, tests)
5. ✅ Commits if pass, marks complete (`- [x] Task`)
6. ✅ Appends to `.crewswarm/progress.txt` (learnings)
7. ✅ Repeats until all items checked

**Usage:**
```bash
# Run Ralph loop (max 10 iterations)
./scripts/ralph-loop.sh 10 /path/to/project

# Or use current directory
./scripts/ralph-loop.sh 10
```

## Next: Make Agents Fresh Per Task

Current problem:
```javascript
// gateway-bridge.mjs runs as daemon
node gateway-bridge.mjs crew-coder
// Stays running, handles multiple tasks, context accumulates
```

Ralph approach:
```bash
# Spawn fresh instance per task
node gateway-bridge.mjs crew-coder --one-shot <<EOF
Task: Add login form
Context: $(cat .crewswarm/progress.txt)
EOF
# Exit after task
```

Want me to implement **one-shot mode** for gateway-bridge.mjs so each dispatch gets fresh context?

## External Context: Quick Wins

1. **Obsidian vault sync** (1 day)
   - Mount vault as read-only
   - Search markdown on agent spawn
   - Include relevant notes in prompt

2. **Meeting notes webhook** (2 hours)
   - POST endpoint for Zapier/Make
   - Store in `memory/meeting-notes/`
   - Auto-injected when customer name mentioned

3. **Read-only DB queries** (1 day)
   - New tool: `@@QUERY_PROD_DB`
   - Allowlist of safe SELECT queries
   - Returns customer config/state

Which do you want first?
