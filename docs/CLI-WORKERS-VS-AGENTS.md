# CLI Workers vs Agents — WTF is the Difference?

**Date**: 2026-03-02  
**Status**: Clear explanation of the architecture

---

## TL;DR - They're DIFFERENT Things in Different Layers

| Thing | What It Is | Where It Lives | What It Does |
|-------|------------|----------------|--------------|
| **CrewSwarm Agents** | RT bus daemons | Main repo `gateway-bridge.mjs` | 20 specialists that receive tasks via RT bus and call LLMs |
| **crew-cli "Workers"** | Internal 3-tier system | `crew-cli/src/` | crew-cli's own routing system (L1 router → L2 planner → L3 workers) |
| **crew-cli as Engine** | Execution engine | `lib/engines/crew-cli.mjs` | One of 7 engines CrewSwarm agents can use to write code |

---

## The Two Layers (This is the Confusion)

### Layer 1: CrewSwarm Main Stack (20 Agents)

```
crew-lead (chat interface)
    ↓
RT Bus (WebSocket message broker)
    ↓
20 Agents running as daemons:
  - crew-coder
  - crew-pm  
  - crew-qa
  - crew-fixer
  - crew-architect ← YOU'RE HERE
  - crew-main
  - crew-github
  - etc.
```

**Each agent is a separate `gateway-bridge.mjs` process** listening on the RT bus.

When a task arrives, the agent:
1. Calls an LLM (deepseek-reasoner, claude-sonnet, etc.)
2. OR routes through an **execution engine** to write code

### Layer 2: crew-cli (Internal 3-Tier System)

```
crew-cli
  ↓
Tier 1: Router (cheap/fast)
  - Classifies: CODE vs PLAN vs QA vs SEARCH
  - Model: gemini-2.0-flash ($0.075/M)
  ↓
Tier 2: Planner (smart decomposition)  
  - Breaks task into steps
  - Model: claude-sonnet-4-5 ($3/M)
  ↓
Tier 3: Workers (parallel execution)
  - Executes micro-tasks in parallel
  - Model: varies by task type
```

**crew-cli's "workers"** = Tier 3 parallel task executors **inside crew-cli**.

---

## How They Interact (The Key Part)

### Option 1: CrewSwarm Agent → crew-cli Engine

```
User: "add auth with JWT"
  ↓
crew-lead receives chat
  ↓
Dispatches to crew-coder (CrewSwarm agent)
  ↓
crew-coder gateway sees: engine = "crew-cli"
  ↓
Calls: runCrewCLITask(prompt, {agent, model, projectDir})
  ↓
crew-cli runs internally:
  - Router: "This is CODE task"
  - Planner: "Need: create auth.ts, update app.ts"
  - Workers: Parallel write files
  ↓
Returns result to crew-coder
  ↓
crew-coder replies to RT bus → crew-lead → user
```

**In this flow**:
- **CrewSwarm agent** (crew-coder) = The daemon receiving the task
- **crew-cli** = The execution engine that writes the code
- **crew-cli workers** = Internal tier-3 parallel executors

### Option 2: crew-cli Standalone (No CrewSwarm)

```
User in terminal: crew chat "add auth"
  ↓
crew-cli runs standalone:
  - Router: CODE task
  - Planner: Decompose
  - Workers: Execute
  ↓
Result printed to terminal
```

**In this flow**:
- **No CrewSwarm agents involved** — it's just crew-cli
- crew-cli's internal routing picks the right "worker" tier

---

## The Confusion: "Workers" Has Two Meanings

### Meaning 1: CrewSwarm Agents (RT Bus Workers)

20 daemon processes that:
- Listen on RT bus for tasks
- Each has a specialty (coder, PM, QA, etc.)
- Call LLMs or execution engines
- Running: `ps aux | grep gateway-bridge`

**Example**: crew-architect is a **CrewSwarm agent**.

### Meaning 2: crew-cli Tier 3 Workers (Internal)

Parallel task executors inside crew-cli's 3-tier system:
- Not separate processes
- Part of crew-cli's internal pipeline
- Execute micro-tasks in parallel
- Code: `crew-cli/src/orchestrator/worker-pool.ts`

**Example**: When crew-cli breaks "add auth" into 3 files, Tier 3 workers write them in parallel.

---

## Your Current Setup (crew-architect)

```json
{
  "id": "crew-architect",
  "model": "deepseek/deepseek-reasoner",     // ← For direct LLM calls
  "opencodeModel": "opencode/big-pickle",     // ← For OpenCode engine
  "cursorCliModel": "sonnet-4.5-thinking",    // ← For Cursor engine
  "useCrewCLI": false                         // ← NOT using crew-cli engine
}
```

**What this means**:
1. **crew-architect** = A CrewSwarm agent (Layer 1)
2. When it needs to write code → uses **OpenCode engine** with `big-pickle` model
3. When it needs to think → uses **DeepSeek reasoner** directly
4. **crew-cli is NOT involved** (useCrewCLI: false)

---

## If You Set `useCrewCLI: true`

```json
{
  "id": "crew-architect",
  "model": "deepseek/deepseek-reasoner",
  "useCrewCLI": true   // ← NOW uses crew-cli as execution engine
}
```

**What would happen**:
1. crew-architect (CrewSwarm agent) receives task
2. Routes to crew-cli engine instead of OpenCode
3. crew-cli internally:
   - Router (Tier 1): Classifies task
   - Planner (Tier 2): Decomposes into steps
   - Workers (Tier 3): Executes in parallel
4. Result returned to crew-architect
5. crew-architect replies to user

**In this setup**:
- **CrewSwarm agent** = crew-architect daemon
- **Execution engine** = crew-cli
- **crew-cli workers** = Internal Tier 3 parallel executors

---

## Visual Architecture

```
┌─────────────────────────────────────────────────────┐
│              LAYER 1: CrewSwarm Main                │
│                                                     │
│  crew-lead (chat) → RT Bus → 20 Agents             │
│  ┌────────────────────────────────────────┐        │
│  │ crew-architect (agent daemon)          │        │
│  │  - Listens on RT bus                   │        │
│  │  - Receives tasks                      │        │
│  │  - Calls LLM OR engine                 │        │
│  └───────────┬────────────────────────────┘        │
└──────────────┼──────────────────────────────────────┘
               │ Calls execution engine
               ▼
┌─────────────────────────────────────────────────────┐
│         LAYER 2: Execution Engine (crew-cli)        │
│                                                     │
│  ┌───────────────────────────────────────────┐    │
│  │ Tier 1: Router (gemini-2.0-flash)        │    │
│  │   - Classify: CODE/PLAN/QA/SEARCH        │    │
│  └────────────────┬──────────────────────────┘    │
│                   ▼                                │
│  ┌───────────────────────────────────────────┐    │
│  │ Tier 2: Planner (claude-sonnet-4-5)      │    │
│  │   - Decompose into micro-tasks           │    │
│  └────────────────┬──────────────────────────┘    │
│                   ▼                                │
│  ┌───────────────────────────────────────────┐    │
│  │ Tier 3: Workers (parallel)               │    │
│  │   - Execute tasks in parallel            │    │
│  │   - Write files, run tests, etc.         │    │
│  └───────────────────────────────────────────┘    │
│                                                     │
│  These "workers" are internal to crew-cli          │
└─────────────────────────────────────────────────────┘
```

---

## Key Differences Table

| Aspect | CrewSwarm Agents | crew-cli Workers |
|--------|------------------|------------------|
| **What** | 20 specialist daemons | Tier 3 parallel executors |
| **Where** | `gateway-bridge.mjs` processes | Inside `crew-cli` binary |
| **How many** | 20 separate processes | N parallel threads (configurable) |
| **Purpose** | Receive tasks, orchestrate | Execute micro-tasks in parallel |
| **Communication** | RT bus (WebSocket) | In-process (TypeScript) |
| **Visible** | `ps aux \| grep gateway` | Not visible (internal) |
| **Examples** | crew-coder, crew-pm, crew-architect | File writer, test runner, git committer |
| **Model config** | Per-agent in `crewswarm.json` | Tier-specific in crew-cli |

---

## So WTF Should You Call Them?

### Use These Terms:

| Term | Meaning |
|------|---------|
| **CrewSwarm agents** | The 20 RT bus daemons (crew-coder, crew-pm, etc.) |
| **Execution engines** | OpenCode, Cursor CLI, crew-cli, Claude Code, etc. |
| **crew-cli tiers** | Router (L1), Planner (L2), Workers (L3) |
| **crew-cli workers** | The Tier 3 parallel executors inside crew-cli |

### DON'T Say:

❌ "CLI workers" (ambiguous — workers of what?)  
❌ "crew-cli agents" (they're not agents, they're tiers)  
❌ "Gateway workers" (the gateway doesn't have workers)

### DO Say:

✅ "CrewSwarm has 20 agents"  
✅ "crew-cli is an execution engine"  
✅ "crew-cli's Tier 3 workers execute tasks in parallel"  
✅ "crew-architect routes to crew-cli engine"

---

## Summary: The Relationship

```
CrewSwarm Agent (e.g., crew-architect)
  ├─ Uses: deepseek/deepseek-reasoner (for thinking)
  └─ Uses execution engine when coding:
       ├─ Option A: OpenCode → big-pickle model
       ├─ Option B: Cursor CLI → sonnet-4.5-thinking
       ├─ Option C: crew-cli → internal 3-tier system
       │    ├─ Tier 1: Router
       │    ├─ Tier 2: Planner  
       │    └─ Tier 3: Workers (parallel execution)
       └─ Option D: Claude Code, Codex, Gemini CLI, etc.
```

**They're complementary, not competing:**
- **CrewSwarm agents** = Task orchestrators (who does what)
- **crew-cli** = Code execution engine (how code gets written)
- **crew-cli workers** = Internal parallelization (how crew-cli is fast)

---

## Your Setup Recommendation

**Current**:
- crew-architect: DeepSeek reasoner (thinking) + OpenCode/big-pickle (coding)

**Could Try**:
```json
{
  "id": "crew-architect",
  "model": "deepseek/deepseek-reasoner",
  "useCrewCLI": true  // ← Try crew-cli as execution engine
}
```

**Why**:
- crew-cli's 3-tier system might be faster than OpenCode for complex tasks
- Built-in QA loop, sandbox, git-aware context
- Same free `big-pickle` model can be used in Tier 3

**Test**:
```bash
# Set crew-architect to use crew-cli
# Then dispatch a coding task
dispatch crew-architect to add a REST endpoint for user profiles

# Compare:
# - Speed (crew-cli parallelizes via Tier 3 workers)
# - Quality (crew-cli has QA loop)
# - Cost (both use free models)
```

---

**Bottom line**: CrewSwarm agents and crew-cli workers are different layers of the stack. Not competitors — they work together. 🚀
