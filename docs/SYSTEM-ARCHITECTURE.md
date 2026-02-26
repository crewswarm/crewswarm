# CrewSwarm — System Architecture

**Last Updated:** 2026-02-26

---

## Overview

CrewSwarm is a standalone multi-agent orchestration platform. A conversational commander (`crew-lead`) receives natural-language input, dispatches work to specialist agents over a WebSocket message bus, and each agent independently calls its configured LLM, executes real tool calls (file writes, shell commands), and reports results back. No third-party orchestration service required.

---

## Component Map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Control Surfaces                                │
│                                                                              │
│  Dashboard (4319)  SwiftBar (macOS)  Telegram  WhatsApp  crew-cli.mjs       │
│       │                  │               │         │          │              │
│       └──────────────────┴───────────────┴─────────┴──────────┘             │
│                                      │                                       │
│                               HTTP :5010                                     │
│                           crew-lead.mjs                                      │
│             (chat · dispatch · pipeline DSL · approval relay)                │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ WebSocket pub/sub
                          ┌────────────┴────────────┐
                          │  RT Bus  :18889          │
                          │  opencrew-rt-daemon.mjs  │
                          └────────────┬────────────┘
                                       │ task.assigned / command.run_task
               ┌──────────┬────────────┼──────────┬──────────┐
               │          │            │          │          │
           crew-pm  crew-coder  crew-qa  crew-fixer  crew-github  …
               │          │
               └──────────┴─────── gateway-bridge.mjs (one process per agent)
                                         │
                                 ┌───────┴───────┐
                                 │  Direct LLM   │  ← Groq/Anthropic/OpenAI/…
                                 └───────┬───────┘
                                         │ reply text
                                 ┌───────┴────────────┐
                                 │  Tool execution     │
                                 │  @@WRITE_FILE       │ → real file I/O
                                 │  @@READ_FILE        │ → real file I/O
                                 │  @@RUN_CMD          │ → shell (approval gate)
                                 └───────┬────────────┘
                                         │ (when OpenCode mode)
                                 ┌───────┴────────────┐
                                 │  Code Engine :4096  │ ← opencode serve
                                 │  (OpenCode /        │    Claude Code CLI
                                 │   Cursor CLI)       │    Cursor CLI
                                 └────────────────────┘

  ┌─────────────────────────────────────────────┐  (optional — core works without)
  │  MCP + OpenAI API  :5020                     │
  │  scripts/mcp-server.mjs                      │
  │  • MCP tools/list + tools/call (JSON-RPC)    │ ← Cursor MCP, Claude Code MCP
  │  • GET /v1/models  POST /v1/chat/completions  │ ← Open WebUI, LM Studio, Aider
  └─────────────────────────────────────────────┘

                               ┌──────────────────────┐
                               │       Memory          │
                               │  memory/brain.md      │ ← persistent facts
                               │  memory/session-log   │ ← task summaries
                               └──────────┬───────────┘
                                          │
                                   crew-scribe.mjs
```

---

## Components

### 1. crew-lead (`crew-lead.mjs`) — Port 5010

The conversational entry point. Receives chat messages, calls the LLM, parses structured markers from replies, and acts on them.

**Markers it handles:**

| Marker | Action |
|---|---|
| `@@DISPATCH {"agent":"...","task":"..."}` | Send one task to one agent via RT bus |
| `@@PIPELINE [{"agent":"...","task":"..."},…]` | Chain sequential tasks; each step starts when the prior completes |
| `@@PROJECT {"name":"...","outputDir":"..."}` | Draft a ROADMAP.md, await user approval, start PM Loop |

**Persistence:**
- Per-session conversation history in `~/.crewswarm/chat-history/<sessionId>.jsonl`
- Telegram sessions are isolated: `telegram-<chatId>` session IDs

**Approval relay:**
- Listens for `cmd.needs_approval` events on the RT bus
- Broadcasts `confirm_run_cmd` SSE to the dashboard browser
- Exposes `POST /approve-cmd` and `POST /reject-cmd` endpoints
- `POST /allowlist-cmd` (GET/POST/DELETE) for managing the command allowlist

**SSE events pushed to dashboard:**
- `chat_message` — user/assistant chat bubbles
- `agent_working` — spinner while agent is running
- `agent_reply` — agent task completion
- `pipeline_progress` — pipeline step advancing
- `pipeline_done` — all pipeline steps complete
- `confirm_run_cmd` — approval toast for shell commands

---

### 2. RT Bus (`scripts/opencrew-rt-daemon.mjs`) — Port 18889

WebSocket pub/sub message bus. All agent communication flows through it.

**Channels:**
- `command` — task dispatch (`command.run_task`, `task.assigned`)
- `done` — task completions written to `done.jsonl`
- `issues` — task failures, artifact validation errors
- `events` — lifecycle events (`agent.heartbeat`, `agent.online`, `cmd.needs_approval`, `cmd.approved`)
- `status` — heartbeats

**Features:**
- Idempotency keys prevent duplicate task execution
- Task leases (distributed locking — only one agent picks up each task)
- Auth token validation
- Event logging to `events.jsonl`

---

### 3. gateway-bridge (`gateway-bridge.mjs`) — one process per agent

The per-agent daemon. Bridges the RT bus to direct LLM API calls and executes tool calls from agent replies.

**Startup flow:**
1. Reads agent config from `~/.crewswarm/crewswarm.json` and `~/.crewswarm/config.json`
2. Loads shared memory files into memory
3. Connects to RT bus, subscribes to channels
4. Sends `agent.online` + heartbeat every 30s

**Task handling:**
1. Receives `command.run_task` or `task.assigned`
2. Claims task lease (idempotency check)
3. Builds prompt: shared memory + task + tool instructions
4. Calls LLM directly (per-agent model from config)
5. Parses `@@TOOL` markers from reply → executes file/shell operations
6. Publishes result to `done` channel
7. On failure: retry with backoff → escalate to `crew-fixer` → write to DLQ

**Tool execution (`executeToolCalls`):**

| Tool marker | Permission | Notes |
|---|---|---|
| `@@WRITE_FILE path\n…\n@@END_FILE` | `write_file` | Creates directories as needed |
| `@@READ_FILE path` | `read_file` | Returns file contents appended to reply |
| `@@MKDIR path` | `mkdir` | Recursive |
| `@@RUN_CMD command` | `run_cmd` | Approval gate for non-auto-approved agents |

**Command approval gate:**
- `AUTO_APPROVE_CMD_AGENTS`: `crew-fixer`, `crew-github`, `crew-pm` run without prompting
- All other agents: publish `cmd.needs_approval` → await `cmd.approved`/`cmd.rejected` (60s timeout)
- Commands matching `~/.crewswarm/cmd-allowlist.json` patterns skip the gate
- `BLOCKED_CMD_PATTERNS` hard-blocks `rm -rf`, `sudo`, `curl|bash`, fork bombs, etc.

**Per-agent tool defaults (`AGENT_TOOL_ROLE_DEFAULTS`):**

| Agent | Allowed tools |
|---|---|
| `crew-qa` | `read_file` |
| `crew-coder` / `crew-coder-front` / `crew-coder-back` / `crew-frontend` / `crew-fixer` | `write_file`, `read_file`, `mkdir`, `run_cmd` |
| `crew-github` | `read_file`, `run_cmd`, `git` |
| `crew-pm` | `read_file`, `dispatch` |
| `crew-security` | `read_file`, `run_cmd` |
| `crew-copywriter` | `write_file`, `read_file` |

**Escalation:**
Failed tasks from `crew-coder`, `crew-coder-front`, `crew-coder-back`, `crew-frontend`, `crew-copywriter` auto-escalate to `crew-fixer` after retries are exhausted.

**Token tracking:**
`callLLMDirect` captures `usage.prompt_tokens` + `usage.completion_tokens` from every API response and accumulates in `~/.crewswarm/token-usage.json`.

**Context window safety:**
`brain.md` and `session-log.md` are tail-trimmed to 8,000 chars on load. Total shared memory capped at 40,000 chars per prompt.

---

### 4. crew-scribe (`scripts/crew-scribe.mjs`) — background daemon

Memory maintenance daemon. Polls `done.jsonl` every 4 seconds.

**For each new task completion:**
1. Calls the fastest available LLM provider to write a one-sentence summary of what the agent accomplished
2. Appends the summary to `memory/session-log.md`
3. Extracts `@@BRAIN: <fact>` tags from agent replies
4. Deduplicates against existing `brain.md` content (70% word-overlap check)
5. Appends new facts to `memory/brain.md`

**Provider priority:** Cerebras → Groq → OpenAI → Mistral → Anthropic (fastest first)

---

### 5. Shared Memory (`memory/`)

Markdown files injected into every agent's task prompt via `gateway-bridge.mjs`.

| File | Purpose | Loaded into prompts? |
|---|---|---|
| `brain.md` | Persistent project facts — agents append `@@BRAIN:` entries | Yes |
| `current-state.md` | System overview and critical task guidance | Yes (gitignored) |
| `agent-handoff.md` | Current status and rules | Yes (gitignored) |
| `orchestration-protocol.md` | Agent roster, dispatch format, tool rules | Yes |
| `session-log.md` | LLM-written task summaries from crew-scribe | No (too large) |
| `telegram-context.md` | Recent Telegram history | No (too noisy) |

---

### 6. Dashboard — Port 4319

Node.js API server (`scripts/dashboard.mjs`) + Vite frontend (`frontend/`). In production, `dashboard.mjs` serves the built Vite app from `frontend/dist`. In development, run `npm run dev` inside `frontend/` to get hot-reload on port 5173 (proxies `/api` to 4319).

**Server-side API routes:**

| Route | Method | Description |
|---|---|---|
| `/api/agents` | GET | Agent list with heartbeat liveness |
| `/api/rt-messages` | GET | Recent RT events (merged done.jsonl + events.jsonl) |
| `/api/token-usage` | GET | Accumulated token/cost data |
| `/api/cmd-allowlist` | GET/POST/DELETE | Proxy to crew-lead allowlist endpoints |
| `/api/telegram-sessions` | GET | List Telegram chatId sessions with recent messages |
| `/api/projects` | GET/POST | Project CRUD |
| `/api/pm-loop/*` | GET/POST | PM Loop start/stop/status |
| `/api/crew-lead/*` | proxy | Forward chat, history, SSE, confirm/discard-project |
| `/api/dlq` | GET | Dead letter queue entries |

**Client-side SSE subscriptions:**
Connects to `crew-lead /events` SSE stream. Handles: `chat_message`, `agent_working`, `agent_reply`, `pipeline_progress`, `pipeline_done`, `confirm_run_cmd`, `pending_project`, `project_launched`.

**Heartbeat liveness:**
`agentHeartbeats` Map (server-side) reads `events.jsonl` tail every 30s for `agent.heartbeat` events. Agent list API returns `ageSec` and `liveness` (fresh <90s / stale / unknown).

---

### 7. Telegram Bridge (`telegram-bridge.mjs`)

Long-polls the Telegram Bot API. Routes every inbound message to `crew-lead /chat` with a per-chatId session (`telegram-<chatId>`).

- Subscribes to crew-lead SSE → forwards `agent_reply` events back to active Telegram sessions
- Maintains in-memory per-chatId conversation history
- Persists Telegram context to `memory/telegram-context.md` (not loaded into prompts)
- All `fetch` calls have client-side timeouts (45s for long-poll, 15s for send) to prevent silent hangs

---

### 8. WhatsApp Bridge (`whatsapp-bridge.mjs`)

Personal bot via [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web automation). Scan QR once; auth persists in `~/.crewswarm/whatsapp-auth/`.

- Routes inbound messages to `crew-lead /chat` with a per-JID session
- `sock.sendMessage` wrapped in a 15-second `Promise.race` timeout — triggers reconnect on stall
- Optional number allowlist via `WA_ALLOWED_NUMBERS` in `crewswarm.json` env block

---

### 9. MCP + OpenAI-compatible API (`scripts/mcp-server.mjs`) — Port 5020 *(optional)*

Exposes all CrewSwarm agents and skills to external tools. **The core stack works without this.** If port 5020 is down, everything else (dashboard, chat, Telegram, WhatsApp, all agents) continues normally.

**MCP (JSON-RPC over HTTP at `/mcp`):**
- `tools/list` — dynamically enumerates agents as tools
- `dispatch_agent`, `list_agents`, `run_pipeline`, `chat_stinki`, `crewswarm_status`, `smart_dispatch`
- Compatible with Cursor MCP, Claude Code MCP, any MCP client

**OpenAI-compatible API:**
- `GET /v1/models` — lists all agents as selectable models
- `POST /v1/chat/completions` — routes to crew-lead or dispatches to a specific agent
- Works with Open WebUI, LM Studio, Aider, Continue.dev

---

## Data Flow — end to end

```
User types in dashboard Chat tab
  → POST /api/crew-lead/chat {message, sessionId}
  → crew-lead calls LLM
  → LLM reply contains @@DISPATCH {"agent":"crew-coder","task":"..."}
  → crew-lead publishes command.run_task on RT bus
  → RT bus delivers to crew-coder's gateway-bridge daemon
  → gateway-bridge builds prompt (shared memory + task + tool instructions)
  → gateway-bridge calls Anthropic API directly
  → LLM reply contains @@WRITE_FILE src/auth.ts \n <code> \n @@END_FILE
  → gateway-bridge writes file to disk
  → gateway-bridge publishes task.done on RT bus
  → done.jsonl records the completion
  → crew-scribe reads done.jsonl, calls Groq, writes summary to session-log.md
  → crew-lead receives task.done, broadcasts agent_reply SSE
  → dashboard browser shows agent reply bubble in chat
```

---

## Ports and processes

| Process | Port | Config |
|---|---|---|
| `opencrew-rt-daemon.mjs` | 18889 (WebSocket) | `~/.crewswarm/config.json` (rt.authToken) |
| `crew-lead.mjs` | 5010 (HTTP) | `~/.crewswarm/config.json`, `crewswarm.json`, `agent-prompts.json` |
| `scripts/dashboard.mjs` | 4319 (HTTP) | `~/.crewswarm/`; serves `frontend/dist` Vite build |
| `scripts/mcp-server.mjs` | 5020 (HTTP) | optional; reads crew-lead :5010 dynamically |
| Code Engine (`opencode serve`) | 4096 (HTTP) | optional; used when agents run in OpenCode mode |
| `gateway-bridge.mjs` × N | — (outbound only) | `OPENCREW_RT_AGENT` env var per process |
| `telegram-bridge.mjs` | — (outbound only) | `TELEGRAM_BOT_TOKEN` env var |
| `whatsapp-bridge.mjs` | — (outbound only) | Baileys auth in `~/.crewswarm/whatsapp-auth/` |
| `scripts/crew-scribe.mjs` | — (no port) | reads `done.jsonl`, writes `memory/` |

---

## Key files on disk

| Path | Purpose |
|---|---|
| `~/.crewswarm/crewswarm.json` | **Canonical:** agents, providers (API keys), per-agent model assignments, tool permissions. |
| `~/.crewswarm/config.json` | RT auth token; optional crew-lead model. |
| `~/.crewswarm/agent-prompts.json` | Per-agent system prompts. |
| `~/.crewswarm/chat-history/*.jsonl` | Per-session conversation history |
| `~/.crewswarm/token-usage.json` | Accumulated token/cost data |
| `~/.crewswarm/cmd-allowlist.json` | Pre-approved @@RUN_CMD patterns |
| `~/.crewswarm/scribe-state.json` | crew-scribe read cursor for done.jsonl |
| `~/.crewswarm/workspace/shared-memory/…/done.jsonl` | Task completion log (RT bus output). Default; overridden by `SHARED_MEMORY_DIR`. |
| `~/.crewswarm/workspace/shared-memory/…/events.jsonl` | RT bus event log |
| `~/.crewswarm/logs/dlq/*.json` | Failed tasks pending replay (or under shared-memory per RT daemon). |
