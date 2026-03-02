# ALL FLOWS IN CREWSWARM - Reality Check

## You Have 3 Orchestrators Doing the Same Thing

### 1. **PM Loop** (`pm-loop.mjs`) - ✅ PRIMARY
- Reads ROADMAP.md
- Expands tasks using `orchestrator` agent's model (configurable in dashboard)
  - Falls back to `crew-pm` model if orchestrator not set
  - Falls back to Perplexity → Cerebras → Groq → local if no agent model
- Dispatches to gateway-bridge
- Self-extends roadmap
- **Status:** WORKS, actively maintained

### 2. **Phased Orchestrator** (`phased-orchestrator.mjs`) - ❌ OVERLAP
- Reads ROADMAP.md
- Dispatches tasks in phases
- Same as PM loop but less features
- **Status:** Duplicate, deprecate

### 3. **Continuous Build** (`continuous-build.mjs`) - ❌ OVERLAP
- Reads ROADMAP.md
- Dispatches until done
- Same as PM loop with no self-extend
- **Status:** Duplicate, deprecate

### 4. **Ralph Loop** (`ralph-loop.sh`) - ❌ DUPLICATE SLOP
- Reads ROADMAP.md
- Dispatches tasks
- Bash reimplementation of pm-loop
- **Status:** DELETE, just added today

---

## Your Real Flows (Clean Ones)

### ✅ Manual Flow: crew-lead Chat
**Path:** User → chat-handler → wave-dispatcher → gateway-bridge

**Use case:** One-off tasks, manual dispatch

### ✅ Autonomous Flow: PM Loop
**Path:** pm-loop → gateway-bridge (daemon)

**Use case:** Continuous roadmap execution

### ✅ Proactive Flow: Background Consciousness
**Path:** background.mjs → gateway-bridge

**Use case:** Idle reflection, proactive suggestions

---

## What to Pull from Ralph

### Only 2 Things Matter:

**1. One-Shot Mode (Fresh Context)**
```javascript
// Current: gateway-bridge stays as daemon
// Problem: context accumulates (50k → 100k → 150k tokens)

// Ralph: gateway-bridge exits after task
// Benefit: fresh 200k tokens every time
```

**2. Progress Tracking (Explicit Learnings)**
```javascript
// Current: brain.md (implicit learnings)
// Ralph: progress.txt (explicit per-iteration learnings)

### Iteration 5
Task: Add login
Outcome: SUCCESS
Learnings: Auth context is in src/lib/auth.ts, always import from there
```

---

## Integration Plan (Minimal)

### Step 1: Add One-Shot to Gateway Bridge (5 lines)

```javascript
// gateway-bridge.mjs - add at line ~15
const ONE_SHOT = process.env.CREWSWARM_ONE_SHOT === '1';

// At end of task execution
if (ONE_SHOT) {
  console.log('[gateway-bridge] ONE-SHOT: Exiting after task');
  process.exit(0);
}
```

### Step 2: Add to PM Loop (2 lines)

```javascript
// pm-loop.mjs - add at line ~65
const ONE_SHOT_MODE = process.env.PM_ONE_SHOT === '1';

// Before spawning gateway
if (ONE_SHOT_MODE) {
  process.env.CREWSWARM_ONE_SHOT = '1';
}
```

### Step 3: Add Progress Tracking to PM Loop

```javascript
// pm-loop.mjs - add function
async function recordProgress(task, result, iteration) {
  const progressFile = join(OUTPUT_DIR, '.crewswarm', 'progress.txt');
  const entry = `
### Iteration ${iteration} - ${new Date().toISOString()}
**Task:** ${task.description}
**Outcome:** ${result.status}
**Learnings:** ${result.learnings || 'None recorded'}

---
`;
  await appendFile(progressFile, entry);
}

// In dispatch loop - inject recent progress
const progressFile = join(OUTPUT_DIR, '.crewswarm', 'progress.txt');
const recentProgress = existsSync(progressFile)
  ? readFileSync(progressFile, 'utf8').slice(-5000)  // Last 5KB
  : '';

const enhancedPrompt = `${task.prompt}

**Context from previous iterations:**
${recentProgress}
`;
```

### Step 4: Delete Slop

```bash
rm scripts/ralph-loop.sh
rm lib/gateway/one-shot-wrapper.mjs
rm lib/gateway/one-shot-handler.mjs

# Deprecate old orchestrators (add warning at top)
# phased-orchestrator.mjs
# continuous-build.mjs
```

---

## Final Clean Architecture

```
USER INPUT
│
├─→ Manual: crew-lead chat → wave-dispatcher → gateway-bridge
│
├─→ Autonomous: pm-loop (one-shot) → gateway-bridge → exit
│
└─→ Proactive: background-consciousness → gateway-bridge

BACKGROUND SERVICES (independent)
└─→ ci-monitor.sh (polls CI, auto-retries)
```

**3 flows, no overlap.**

---

## What About Worktree/Multi-Review/External-Context?

**Keep the scripts but DON'T integrate yet:**

```bash
# These are useful but optional:
scripts/worktree-manager.sh     # Parallel work (overkill for now)
scripts/multi-ai-review.sh      # PR review (nice-to-have)
scripts/external-context.sh     # Obsidian sync (needs setup)
scripts/ci-monitor.sh           # Auto-retry (run separately)
```

**Why not integrate?**
- Adds complexity
- PM loop works fine without them
- Integrate later when you actually need parallel work

**When to add:**
- Worktrees: When you need 3+ agents working simultaneously
- Multi-review: When you want automated PR review
- External context: When you have Obsidian vault with customer notes

---

## My Recommendation

**Minimal Integration (Do This):**

1. ✅ Add one-shot flag to gateway-bridge.mjs (10 lines total)
2. ✅ Add progress.txt to pm-loop.mjs (20 lines total)
3. ✅ Delete ralph-loop.sh + one-shot wrapper files
4. ✅ Add deprecation warning to phased-orchestrator + continuous-build

**Total changes:** ~30 lines
**Result:** Clean 3-flow architecture + fresh context per task

**Don't integrate yet:**
- ❌ Worktrees (complex, not needed yet)
- ❌ Multi-review (nice-to-have)
- ❌ External context (needs Obsidian setup)

Keep it simple. Add those later if you need them.

Want me to implement the minimal version?
