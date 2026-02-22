# OpenClaw Multi-Agent System Architecture

**Last Updated:** 2026-02-20  
**Goal:** Autonomous dev team that takes high-level orders, breaks them down, executes in parallel, and produces perfect code with zero human intervention.

---

## 🎯 The Vision

```
YOU: "Build user authentication system"
PM: *analyzes → breaks into 8 tasks → dispatches to 6 agents → monitors → retries failures*
    ├─ Codex: Writes JWT functions ✅
    ├─ Tester: Writes 47 tests ✅
    ├─ Guardian: Security audit ✅
    └─ Debugger: Fixes edge case ✅
PM: "Complete. 12 files changed. All tests pass. Production ready."
```

---

## 📐 Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER (You)                               │
│                 "Build feature X" or "Fix bug Y"                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  CONTROL INTERFACES (3 ways in)                  │
├─────────────────┬───────────────────┬───────────────────────────┤
│ 1. CLI Tool     │ 2. SwiftBar Menu  │ 3. Control UI (Quill)     │
│ openswitchctl   │ macOS menu bar    │ Cursor/OpenClaw UI        │
│ send <agent>    │ Quick messaging   │ Quill runs orchestrator   │
└────────┬────────┴────────┬──────────┴──────────┬────────────────┘
         │                 │                      │
         └─────────────────┼──────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│              OPENCREW RT MESSAGE BUS (WebSocket)                 │
│                    ws://127.0.0.1:18889                          │
│                                                                  │
│  Channels:                                                       │
│  - command   (task dispatch)                                     │
│  - done      (success reports)                                   │
│  - issues    (failures/errors)                                   │
│  - status    (health checks)                                     │
│  - assign    (task routing)                                      │
│                                                                  │
│  Features:                                                       │
│  - Real-time pub/sub                                             │
│  - Idempotency keys (duplicate prevention)                       │
│  - Task leases (only 1 agent picks up task)                      │
│  - Correlation IDs (track task chains)                           │
│  - Auth tokens (optional)                                        │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ↓ (7 daemons subscribe)
┌─────────────────────────────────────────────────────────────────┐
│            GATEWAY-BRIDGE DAEMONS (7 running)                    │
│              ~/.openclaw/logs/openclaw-rt-*.log                  │
│                                                                  │
│  Each daemon:                                                    │
│  - Listens on OpenCrew RT channels                               │
│  - Loads shared memory (4 .md files)                             │
│  - Routes tasks to OpenClaw Gateway                              │
│  - Enforces retry policy & DLQ                                   │
│  - Validates coding artifacts                                    │
│                                                                  │
│  Agents:                                                         │
│  1. crew-main (Quill 🦊)        → OpenClaw agent "main"         │
│  2. crew-pm (Planner 📋)        → OpenClaw agent "pm"           │
│  3. crew-coder (Codex ⚡)       → OpenClaw agent "coder"        │
│  4. crew-coder-2 (Codex2 ⚡)    → OpenClaw agent "coder"        │
│  5. crew-qa (Tester 🔬)         → OpenClaw agent "qa"           │
│  6. crew-fixer (Debugger 🐛)    → OpenClaw agent "fixer"        │
│  7. security (Guardian 🛡️)      → OpenClaw agent "security"     │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ↓ (bridge.chat calls)
┌─────────────────────────────────────────────────────────────────┐
│              OPENCLAW GATEWAY (Agent Runtime)                    │
│                   ws://127.0.0.1:18789                           │
│                                                                  │
│  Config: ~/.openclaw/openclaw.json                               │
│  - Defines 6 specialized agents                                  │
│  - Each has model, identity, tools, systemPrompt                 │
│                                                                  │
│  Features:                                                       │
│  - Session management                                            │
│  - Tool execution (read/write/exec/grep/web_search)              │
│  - Model switching (Groq/OpenAI/Anthropic/NVIDIA)                │
│  - Subagent spawning (native OpenClaw feature)                   │
│  - Rate limit handling                                           │
│  - Streaming responses                                           │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ↓ (tool calls)
┌─────────────────────────────────────────────────────────────────┐
│                    TOOL EXECUTION LAYER                          │
│                                                                  │
│  File Operations:                                                │
│  - write(file_path, contents)                                    │
│  - search_replace(file_path, old, new)                           │
│  - read_file(target_file)                                        │
│  - list_dir(target_directory)                                    │
│  - grep(pattern, path)                                           │
│                                                                  │
│  Code Execution:                                                 │
│  - exec(command, yieldMs)                                        │
│  - Runs bash/zsh commands                                        │
│  - Can install packages, run tests, git operations               │
│                                                                  │
│  Internet:                                                       │
│  - web_search(query)                                             │
│  - web_fetch(url)                                                │
│                                                                  │
│  Browser Automation:                                             │
│  - browser (via Chrome extension relay)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🧠 Tech Stack Breakdown

### 1. **OpenCrew RT Plugin** (Real-time Message Bus)
- **Language:** TypeScript
- **Runtime:** Compiled to JavaScript, runs via Node.js
- **Location:** `~/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/`
- **Protocol:** Custom WebSocket pub/sub
- **Channels:** `command`, `done`, `issues`, `status`, `assign`, `handoff`, `reassign`, `events`
- **Features:**
  - Idempotency (prevents duplicate task execution)
  - Task leases (distributed locking)
  - Correlation IDs (track task chains)
  - Event logging (all messages → `events.jsonl`)
  - Auth tokens (optional)
- **Status:** ✅ **WORKING**

---

### 2. **Gateway Bridge** (Agent Daemon Wrapper)
- **Language:** JavaScript (ES Modules)
- **File:** `~/Desktop/OpenClaw/gateway-bridge.mjs`
- **Purpose:** Bridges OpenCrew RT ↔ OpenClaw Gateway
- **Key Functions:**
  - Loads shared memory (6 .md files) on every task
  - Injects mandatory startup/shutdown protocol into prompts
  - Routes tasks to appropriate OpenClaw agent
  - Validates coding artifacts (temporarily disabled)
  - Implements retry policy with exponential backoff
  - DLQ routing for failed tasks
  - Prevents routing to broken OpenCode CLI
- **Environment Variables:**
  - `OPENCREW_RT_AGENT` - Which agent this daemon represents
  - `OPENCREW_OPENCODE_ENABLED=0` - Bypass broken OpenCode plugin system
  - `OPENCREW_RT_CHANNELS` - Which channels to subscribe to
- **Status:** ✅ **WORKING** (all 7 daemons running)

---

### 3. **OpenClaw Gateway** (Agent Execution Engine)
- **Language:** TypeScript/JavaScript
- **Binary:** `/usr/local/lib/node_modules/openclaw/`
- **Config:** `~/.openclaw/openclaw.json`
- **Protocol:** WebSocket on `ws://127.0.0.1:18789`
- **Purpose:** Executes LLM-powered agents with real tool access
- **Agents Configured:**

| ID       | Name      | Model                         | Role                          | Tools                      |
|----------|-----------|-------------------------------|-------------------------------|----------------------------|
| `main`   | Quill 🦊  | `groq/llama-3.3-70b-versatile`| Main coordinator              | coding, web_search, web_fetch |
| `coder`  | Codex ⚡  | `groq/llama-3.3-70b-versatile`| Code implementation           | coding, web_search, web_fetch |
| `pm`     | Planner 📋| `groq/llama-3.3-70b-versatile`| **Project orchestrator**      | coding, web_search, web_fetch |
| `qa`     | Tester 🔬 | `groq/llama-3.3-70b-versatile`| Testing & validation          | coding, web_search, web_fetch |
| `fixer`  | Debugger 🐛| `groq/llama-3.3-70b-versatile`| Bug fixing                    | coding, web_search, web_fetch |
| `security`| Guardian 🛡️| `groq/llama-3.3-70b-versatile`| Security audits              | coding, web_search, web_fetch |

- **Features:**
  - Native subagent spawning (OpenClaw's built-in feature)
  - Multi-model support (Groq, OpenAI, Anthropic, xAI, NVIDIA)
  - Session persistence
  - Streaming responses
  - Rate limit handling
  - `maxConcurrent: 20` (can run 20 tasks in parallel)
- **Status:** ✅ **WORKING** (all agents can code)

---

### 4. **Shared Memory System** (Persistent Context)
- **Location:** `~/Desktop/OpenClaw/memory/`
- **Files (full set):**
  1. `current-state.md` - Current project snapshot
  2. `decisions.md` - Durable architectural decisions
  3. `open-questions.md` - Blockers needing resolution
  4. `agent-handoff.md` - What happened, what's next
  5. `session-log.md` - Append-only execution log
  6. `orchestration-protocol.md` - PM's dispatch instructions
- **Protocol:** `protocol.md` defines mandatory startup/shutdown checklist
- **Injection:** `gateway-bridge.mjs` loads 4 files (current-state, decisions, agent-handoff, orchestration-protocol) and injects them into every task prompt
- **Purpose:**
  - Agents never lose context across sessions
  - Prevents duplicate work
  - Ensures consistency
  - Provides handoff continuity
- **Status:** ✅ **WORKING** (auto-bootstrap if files missing)

---

### 5. **Control Scripts**
#### `openswitchctl`
- **Language:** Bash
- **Location:** `~/bin/openswitchctl`
- **Commands:**
  - `start` - Start all RT server + agent daemons
  - `stop` - Stop all services
  - `restart-all` - Restart everything
  - `status` - Show health (rt:up, agents:7/7)
  - `send <agent> <message>` - Dispatch task to specific agent
  - `broadcast <message>` - Send to all agents
  - `restart-openclaw-gateway` - Restart OpenClaw Gateway process
- **Status:** ✅ **WORKING**

---

### 6. **Monitoring Dashboard**
- **Language:** JavaScript (Node.js)
- **File:** `~/.openclaw/workspace/skills/swarm_mcp/dashboard.mjs`
- **URL:** `http://127.0.0.1:4318`
- **Features:**
  - Real-time agent status
  - RT message viewer (`done`, `issues`, `status` channels)
  - DLQ (Dead Letter Queue) viewer & replay
  - Message sending UI (select agent, type message, send)
  - Queue metrics
  - Session viewer
- **Tech:**
  - Express.js server
  - Server-Sent Events (SSE) for real-time updates
  - Proxies to OpenCode API (`http://127.0.0.1:4096`)
  - Reads `.jsonl` files for RT messages
- **Status:** ✅ **WORKING**

---

### 7. **SwiftBar Menu** (macOS Menu Bar UI)
- **Language:** Bash
- **File:** `~/Library/Application Support/SwiftBar/plugins/openswitch.10s.sh` (source: `contrib/swiftbar/`)
- **Refresh:** Every 10 seconds
- **Features:**
  - Shows agent count & status
  - "Message Agent" submenu (links to dashboard with pre-selected agent)
  - Queue metrics (tasks in flight)
  - Restart commands
  - Dynamic agent list
- **Status:** ✅ **WORKING** (colors now readable in dark mode)

---

### 8. **Retry Policy & DLQ**
- **Implementation:** `gateway-bridge.mjs` (lines 58-62, 1585-1900)
- **Features:**
  - Max retries: 2 (3 for coding tasks)
  - Exponential backoff: 2000ms base
  - Task leases: 120 seconds
  - Heartbeat: 15 seconds
  - DLQ routing on max retries
  - DLQ replay from dashboard
- **DLQ Storage:** `~/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/dlq/*.json`
- **Status:** ✅ **WORKING**

---

### 9. **Orchestration System** ✅ WORKING (via external orchestrators)
- **Design:** External orchestrator drives PM (plan) + parser + workers; PM does not dispatch directly.
- **Inspired by:** AutoGen Group Chat, CrewAI, OpenAI Realtime Agents.
- **Current Implementation:**
  - `unified-orchestrator.mjs`: PM natural-language plan → parser → JSON → `gateway-bridge.mjs --send` to workers → verification
  - PM and workers use targeted `--send` (no broadcast race)
  - Shared memory protocol ensures context persistence
- **Status:** ✅ **WORKING** — run `node unified-orchestrator.mjs "Your requirement"` or `node scripts/run.mjs "Your requirement"`

---

## 🔗 Key Integration Points

### OpenCrew RT ↔ Gateway Bridge
```javascript
// gateway-bridge.mjs subscribes to RT channels
const client = new OpenCrewRTClient({
  url: OPENCREW_RT_URL,
  agentId: OPENCREW_RT_AGENT,
  channels: ['command', 'assign', 'handoff', 'reassign', 'events'],
  token: OPENCREW_RT_TOKEN
});

client.on('envelope', async (envelope) => {
  await handleRealtimeEnvelope(envelope, client, bridge);
});
```

### Gateway Bridge ↔ OpenClaw Gateway
```javascript
// gateway-bridge.mjs maps RT agent names → OpenClaw agent IDs
const openclawAgentId = OPENCREW_TO_OPENCLAW_AGENT_MAP[OPENCREW_RT_AGENT] || "main";

// Then calls OpenClaw Gateway
const reply = await bridge.chat(finalPrompt, openclawAgentId, { 
  idempotencyKey: dispatchKey 
});
```

### Control UI / Quill → Orchestrator (How Builds Are Dispatched)
When the user says "build X" or "create Y" in the Control UI (Cursor/OpenClaw), **Quill** (main agent) does **not** have `sessions_spawn` or direct swarm channel access. Instead:
1. Quill uses the `exec` tool to run: `node unified-orchestrator.mjs "requirement"`
2. The orchestrator: PM plans → parser converts to JSON → gateway-bridge `--send` to workers → verification
3. Quill reports back the result. See `~/.openclaw/workspace/SOUL.md` and `AGENTS.md` for Quill's dispatch instructions.

---

## 📊 Current Status Summary

| Component              | Status | Notes                                      |
|------------------------|--------|--------------------------------------------|
| OpenCrew RT Bus        | ✅ WORKING | All 7 agents connected                    |
| Gateway Bridge Daemons | ✅ WORKING | All 7 running, loading shared memory      |
| OpenClaw Gateway       | ✅ WORKING | All 6 agents can code                     |
| Shared Memory Protocol | ✅ WORKING | Auto-bootstrap, consistent injection      |
| Retry Policy & DLQ     | ✅ WORKING | Exponential backoff, DLQ replay           |
| Web Dashboard          | ✅ WORKING | Real-time monitoring, messaging UI        |
| SwiftBar Menu          | ✅ WORKING | Dynamic agent list, dark mode colors      |
| Control Scripts        | ✅ WORKING | openswitchctl start/stop/status/send      |
| **PM Orchestration**   | ✅ **WORKING** | **External orchestrator (unified-orchestrator.mjs)** |

---

## 🐛 Historical Note: PM Autonomous Dispatch

**We no longer rely on PM to dispatch directly.** The external `unified-orchestrator.mjs` handles orchestration:
1. Orchestrator asks PM for a natural-language plan
2. Parser converts plan to JSON
3. Orchestrator dispatches each task via `gateway-bridge.mjs --send <agent>`
4. Verification runs after each task

The PM agent still plans and advises; execution is handled by the orchestrator. See [ORCHESTRATOR-GUIDE.md](ORCHESTRATOR-GUIDE.md) and [DELEGATION.md](DELEGATION.md).

---

## 📚 Design Pattern References

Your system is inspired by these patterns:

1. **AutoGen Group Chat** ([link](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/design-patterns/group-chat.html))
   - Sequential turn-taking
   - Manager selects next speaker
   - `RequestToSpeak` message pattern
   - **You have:** Message bus with channels, but no explicit "request to speak"

2. **CrewAI** ([link](https://github.com/crewAIInc/crewAI-examples))
   - Role-based agents (Manager, Researcher, Writer, etc.)
   - Task delegation with dependencies
   - Sequential and parallel execution
   - **You have:** Specialized agents with roles, RT channels for coordination

3. **OpenAI Realtime Agents** ([link](https://github.com/openai/openai-realtime-agents))
   - Real-time WebSocket communication
   - Event-driven architecture
   - Streaming responses
   - **You have:** OpenCrew RT WebSocket bus, event logging

4. **OpenCode** ([link](https://github.com/anomalyco/opencode))
   - Code-focused AI agents
   - Plugin system
   - Session management
   - **You're using:** OpenClaw (fork/alternative) as base agent runtime

---

## 🏗️ Architecture Strengths

✅ **Real-time coordination** via WebSocket message bus  
✅ **Persistent context** via shared memory protocol  
✅ **Fault tolerance** via retry policy & DLQ  
✅ **Parallel execution** via 20 max concurrent sessions  
✅ **Specialized agents** with clear roles  
✅ **Multiple control interfaces** (CLI, dashboard, menu bar)  
✅ **Tool access** for real file/code operations  
✅ **Model flexibility** (can swap Groq/OpenAI/Anthropic easily)  

---

## 🚧 Architecture Gaps

🟡 **Task dependency tracking** - Orchestrator runs tasks sequentially; no explicit "Task B waits for Task A" graph  
🟡 **Parallel task dispatch** - Tasks run one after another; could be parallelized for independent tasks  
🟡 **Control UI sessions_spawn** - Quill cannot spawn OpenClaw subagent sessions; uses exec + orchestrator instead

