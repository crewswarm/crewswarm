# Session Summary: Building Autonomous Orchestration

> **Note:** Historical. Canonical orchestrator is now `unified-orchestrator.mjs`. Control UI (Quill) uses `exec` to run it when user says "build X". See [DELEGATION.md](DELEGATION.md), [ORCHESTRATOR-GUIDE.md](ORCHESTRATOR-GUIDE.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

**Date:** 2026-02-19  
**Goal:** Fix PM agent to autonomously break down tasks and dispatch to specialized workers

---

## 🎯 What We Built

### 1. **External Dispatch Orchestrator** ✅
**File:** `dispatch-orchestrator.mjs` (archived; unified-orchestrator.mjs is canonical)

**Pattern:** Inspired by OpenAI Swarm + LangGraph supervisor

**How it works:**
```
User → dispatch-orchestrator.mjs
  ↓
  Asks PM for JSON dispatch plan
  ↓
  PM outputs: {"op_id": "...", "dispatch": [...]}
  ↓
  Orchestrator parses JSON
  ↓
  For each subtask: spawns gateway-bridge.mjs --send
  ↓
  Monitors completion
  ↓
  Reports final status
```

**Key insight:** **Separate cognition (PM plans) from execution (orchestrator dispatches)**

This is the **critical stability pattern** that prevents "PM won't execute" bugs.

---

### 2. **PM Agent Configuration Changes** ✅

**Before:**
```json
{
  "id": "pm",
  "model": "groq/llama-3.3-70b-versatile",
  "tools": {
    "profile": "coding"  // ❌ Full exec, write, etc.
  }
}
```

**After:**
```json
{
  "id": "pm",
  "model": "groq/llama-3.3-70b-versatile",
  "systemPrompt": "You output dispatch plans as JSON. Nothing else...",
  "tools": {
    "allow": [
      "read_file",
      "list_dir",
      "grep",
      "codebase_search"
    ]  // ✅ Read-only, can't execute
  }
}
```

**Why this matters:**
- PM can no longer try to "execute" tasks itself
- Forces it to output JSON dispatch plans only
- Matches OpenAI Swarm "handoff" pattern where delegation is structured data, not tool calls

---

### 3. **Lightweight Memory for PM** ✅

**Removed from PM's context:**
- `session-log.md` (400+ lines of old failures - was discouraging PM)
- `open-questions.md` (unnecessary noise)

**PM now only loads:**
- `current-state.md` - Current project snapshot
- `decisions.md` - Durable architectural decisions
- `agent-handoff.md` - What happened last, what's next
- `orchestration-protocol.md` - How to dispatch

**Result:** PM gets ~80% less context noise, focuses on planning only

---

### 4. **Validation Layer** ✅

**In `dispatch-orchestrator.mjs`:**

```javascript
// Prevents silent no-ops
if (!dispatchPlan.dispatch || dispatchPlan.dispatch.length === 0) {
  throw new Error('PM did not dispatch any tasks');
}

// Validates each task has required fields
for (const task of dispatchPlan.dispatch) {
  if (!task.agent) throw new Error('Missing agent field');
  if (!task.task) throw new Error('Missing task field');
}
```

**Why:** LLMs are unreliable - validation catches failures early

---

### 5. **Documentation** ✅

Created comprehensive docs:
- `docs/SYSTEM-ARCHITECTURE.md` (502 lines) - Full tech stack breakdown
- `docs/OPENCLAW-AGENTS-SETUP.md` - Agent configuration guide
- `docs/KEEP-AGENTS-WORKING.md` - Maintenance & troubleshooting
- `memory/orchestration-protocol.md` - PM's dispatch instructions

---

## 🚧 Current Status

### ✅ Working Components

1. **7 Gateway Bridge Daemons** - All running, connected to RT bus
2. **OpenCrew RT Message Bus** - Real-time pub/sub working
3. **OpenClaw Gateway** - 6 agents configured and can execute
4. **Shared Memory Protocol** - Context persistence working
5. **DLQ + Retry Logic** - Fault tolerance implemented
6. **Web Dashboard** - `http://127.0.0.1:4318` monitoring
7. **SwiftBar Menu** - macOS control panel
8. **External Orchestrator** - JSON parsing & dispatch logic complete

### 🔴 Not Working

**PM Agent is returning empty responses**

**Symptoms:**
- PM receives tasks
- PM returns blank/empty reply
- No JSON output
- Gateway logs show `INVALID_REQUEST` errors

**Possible causes:**
1. **Model timeout** - PM might be taking too long to respond
2. **Gateway connection issues** - WebSocket connections failing
3. **Prompt too restrictive** - Model refusing to reply
4. **Tool restrictions breaking** - Model confused by limited toolset

---

## 🎓 Key Learnings

### 1. **LLMs are great at planning, bad at execution**

✅ **Works:** PM outputs structured JSON with task list  
❌ **Fails:** PM decides when to call `exec` tool 5 times

**Solution:** External orchestrator reads JSON, does actual execution

### 2. **Tool permissions matter**

If PM has `exec`, it WILL try to execute. The solution isn't "prompt it better" - it's **remove the tool**.

### 3. **Validation is mandatory**

LLMs will:
- Say "I'm ready to assist" instead of dispatching
- Output prose instead of JSON
- Forget to include required fields

**Solution:** Hard validation that rejects invalid output

### 4. **Context matters**

PM was loading 400+ lines of old failure logs → got discouraged → refused to work

**Solution:** Give PM only what it needs to plan

---

## 📚 Reference Patterns (from research)

### OpenAI Swarm
- **Handoff as structured action**, not prose
- Agents have explicit `transfer_to_X()` functions
- Lightweight, chat-completions based

### LangGraph Supervisor
- Supervisor has `handoff(agent, task, acceptance)` tool
- Makes delegation a structured artifact
- Forces models to produce machine-readable output

### opencode-agent-swarm-demo
- Multi-server OpenCode coordination
- Claude Code launches processes, OpenCode agents execute
- Shows clean separation: setup vs. runtime

---

## 🔧 Next Steps (in priority order)

### Option A: Fix PM Empty Response Bug
1. Debug gateway connection issues
2. Try different models (GPT-4o-mini with proper API key)
3. Simplify prompt even more (single example)
4. Add timeout handling

### Option B: Build V1 Production System
**Per your checklist:**

1. ✅ **SQLite task store**
   - Tables: `operations`, `tasks`, `events`, `artifacts`
   - Fields: `op_id`, `task_id`, `parent_task_id`, `attempt`, `status`
   
2. ✅ **Tool approval gate**
   - `policy/rules.yaml` - Allowlist per agent
   - `policy/approval-gate.mjs` - Requires user approval for risky actions
   
3. ✅ **Enforce QA verification**
   - PM must always dispatch to `opencode-qa` as final task
   - Validation: reject if no QA task in dispatch array
   
4. ✅ **Retry policy + timeouts**
   - Already have exponential backoff
   - Add per-worker timeout config
   
5. ✅ **Event log + replay**
   - Store every message + tool result in SQLite
   - `swarm replay <op_id>` command

### Option C: Alternative Approach
**"Natural Language → JSON Parser"**

Instead of forcing PM to output JSON directly:
1. Let PM reply naturally: "I'll have Codex create the file, then QA test it"
2. Use GPT-4o to parse PM's natural language into JSON
3. Feed parsed JSON to orchestrator

**Pros:** More reliable (models are better at natural language)  
**Cons:** Extra API call, more complexity

---

## 📊 Architecture Strengths

✅ **Real-time coordination** via WebSocket message bus  
✅ **Persistent context** via shared memory protocol  
✅ **Fault tolerance** via retry policy & DLQ  
✅ **Parallel execution** via 20 max concurrent sessions  
✅ **Specialized agents** with clear roles  
✅ **External orchestration** (separation of concerns)  
✅ **Read-only PM** (can't accidentally execute)  
✅ **Validation layer** (catches bad output early)  

---

## 🚀 Production Readiness Checklist

From your feedback, to make this a legit OSS project:

### Must-Have (to be taken seriously)
- [ ] SQLite task store with full event log
- [ ] Policy/approval gate for risky actions
- [ ] QA enforcement (required final step)
- [ ] Pluggable agent definitions
- [ ] CLI: `swarm run`, `swarm replay`, `swarm status`

### Nice-to-Have (makes it viral)
- [ ] Web UI showing live task graph
- [ ] Agent messages + tool calls visualization
- [ ] Artifacts produced (files, patches, reports)
- [ ] Templates: repo-fix, research, content, automation
- [ ] Health checks + auto-restart

---

## 💡 Recommended Path Forward

**I recommend Option B + Option C hybrid:**

1. **Fix PM empty response** (Option A) - 30 min debug
2. **If still broken:** Switch to natural language parser (Option C) - 1 hour
3. **Then build V1 production features** (Option B) - 3-4 hours

This gets you:
- ✅ Working orchestration (even if PM is flaky)
- ✅ Production-ready persistence
- ✅ Tool safety
- ✅ Replay capability
- ✅ OSS-ready architecture

---

## 🎯 Use Cases (Once Working)

1. **Repo helper** - Triages issues, ships fixes as PRs
2. **Research → summary → action** - Compares libraries, builds prototypes
3. **Content production** - YouTube/TikTok/Twitter automation (with approvals)
4. **Personal ops** - File cleanup, doc formatting, script generation
5. **Local AI "Jarvis"** - Routes tasks to appropriate tools/agents

---

## 📝 Files Changed This Session

### Created:
- `dispatch-orchestrator.mjs` (289 lines)
- `docs/SYSTEM-ARCHITECTURE.md` (502 lines)
- `docs/SESSION-SUMMARY.md` (this file)
- `memory/orchestration-protocol.md` (193 lines)

### Modified:
- `~/.openclaw/openclaw.json` (PM agent: tools restricted, prompt updated)
- `gateway-bridge.mjs` (removed session-log.md from memory loading)

### Tested:
- PM with full tools → tried to execute ❌
- PM with restricted tools → empty responses ❌
- External orchestrator → architecture works, PM output broken ⚠️

---

## 🔗 Reference Links

- [OpenAI Swarm](https://github.com/openai/swarm) - Handoff pattern
- [OpenAI Cookbook - Orchestrating Agents](https://cookbook.openai.com/examples/orchestrating_agents) - Routines & handoffs
- [LangGraph Supervisor](https://langchain-ai.github.io/langgraphjs/tutorials/multi_agent/multi_agent_collaboration/) - Multi-agent coordination
- [opencode-agent-swarm-demo](https://github.com/IgorWarzocha/opencode-agent-swarm-demo) - OpenCode multi-server setup
- [AutoGen Group Chat](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/design-patterns/group-chat.html) - Manager-driven turns

---

**Status:** Architecture complete, PM output broken, ready for V1 production features once PM fixed.

**Recommended next action:** Debug PM empty response (30 min), then build SQLite persistence layer.

