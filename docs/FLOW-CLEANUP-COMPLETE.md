# Flow Cleanup — COMPLETE ✅

## All Tasks Done

### ✅ 1. Deprecated Old Orchestrators
- `phased-orchestrator.mjs` → Shows deprecation warning, exits with code 1
- `continuous-build.mjs` → Shows deprecation warning, exits with code 1
- Dashboard API → Returns 410 Gone with migration instructions

### ✅ 2. Deleted Ralph Slop
- `scripts/ralph-loop.sh` → DELETED (bash duplicate of pm-loop)
- `lib/gateway/one-shot-wrapper.mjs` → DELETED (wrong approach)
- `lib/gateway/one-shot-handler.mjs` → DELETED (wrong approach)

### ✅ 3. Added One-Shot Mode
**gateway-bridge.mjs:**
- Added `ONE_SHOT` flag at top (reads `CREWSWARM_ONE_SHOT` env var)
- Added exit after task completion when ONE_SHOT enabled
- Fresh 200k context every task instead of accumulating tokens

**pm-loop.mjs:**
- Added `ONE_SHOT_MODE` config flag (reads `PM_ONE_SHOT` env var)
- Sets `CREWSWARM_ONE_SHOT=1` before spawning gateway-bridge
- Logs one-shot mode status on startup

### ✅ 4. Added Progress Tracking
**pm-loop.mjs:**
- New `recordProgress()` function writes to `{OUTPUT_DIR}/.crewswarm/progress.txt`
- Records iteration number, task, outcome, learnings
- Loads recent progress (last 5KB) and injects into PM expansion prompts
- Each iteration learns from previous iterations explicitly

### ✅ 5. Fixed Documentation
- `docs/FLOW-CLEANUP-PLAN.md` → Corrected PM loop model config (uses `orchestrator` or `crew-pm` agent, NOT hardcoded Groq)

---

## Your Clean 3-Flow Architecture

```
1. MANUAL FLOW
   crew-lead chat → wave-dispatcher → gateway-bridge
   Use: one-off tasks, manual dispatch

2. AUTONOMOUS FLOW (with fresh context)
   pm-loop → gateway-bridge (one-shot) → exit
   Use: continuous roadmap execution

3. PROACTIVE FLOW
   background-consciousness → gateway-bridge
   Use: idle reflection, proactive suggestions
```

---

## How to Use

### Enable One-Shot Mode (Fresh Context Per Task)

```bash
# PM loop with fresh context per task
PM_ONE_SHOT=1 node pm-loop.mjs

# Or set in ~/.crewswarm/crewswarm.json:
{
  "env": {
    "PM_ONE_SHOT": "1"
  }
}
```

### Progress Tracking

Progress automatically tracked at `{OUTPUT_DIR}/.crewswarm/progress.txt`:

```
### Iteration 5 - 2026-03-01T12:34:56.789Z
**Task:** Add login endpoint
**Outcome:** success
**Learnings:** Auth context is in src/lib/auth.ts, always import from there

---
```

PM loop reads last 5KB of progress and injects into expansion prompts so each iteration learns from previous work.

---

## Total Changes

- **Lines added:** ~80
- **Lines removed:** ~3000 (deprecated orchestrators, ralph slop)
- **Files changed:** 5
- **Files deleted:** 3

**Result:** Clean 3-flow architecture + fresh context per task + explicit learning loop

---

## Next Steps (Optional)

Keep but don't integrate yet (unless you need them):
- `scripts/worktree-manager.sh` — Parallel work with Git worktrees
- `scripts/multi-ai-review.sh` — Multi-LLM PR reviews
- `scripts/ci-monitor.sh` — Auto-retry on CI failures
- `scripts/external-context.sh` — Obsidian vault integration

Add these later when you actually need parallel development or external context.