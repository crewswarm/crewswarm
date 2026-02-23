# OpenCrewHQ — Features & Use Cases Reference

**Purpose:** Single source of truth for marketing site copy, feature lists, use cases, and technical highlights. Updated to reflect the current state of the system including PM Loop, continuous builds, project management, and the live website.

---

## Tagline / Value Proposition

**OpenCrewHQ** — multi-agent orchestration for builders. Give it one sentence. A PM agent plans it, a crew of specialists builds it, QA validates it, and a fault-recovery system handles the rest. Everything lands on disk. Nothing is faked.

**Hero tagline options:**
- *"One requirement. One crew. Real files."*
- *"Your AI dev team. Runs locally. Ships forever."*
- *"Give it a sentence. The crew handles the rest."*

---

## System Overview

The stack has three layers:

1. **OpenCrew RT** — WebSocket message bus. Agents subscribe to topics, tasks are dispatched targeted to one agent at a time. No broadcast races, no duplicate work.
2. **Direct LLM + tools** — Each agent uses its own model (Groq, Anthropic, OpenAI, etc.) from `~/.crewswarm/crewswarm.json`. Gateway-bridge handles tool execution (file write, read, run_cmd, etc.). An optional legacy gateway on port 18789 is supported but not required.
3. **Orchestration layer** (this repo) — PM planning, phased builds, PM Loop, shared memory, fault recovery, dashboard, SwiftBar control plane.

---

## Core Features

### PM-Led Orchestration
One natural-language requirement triggers a full build. The PM agent (crew-pm) breaks it into 3–5 tasks per phase, assigns the right specialist, and monitors progress. No hand-holding required.

### Phased Builds (PDD)
Large work auto-phases into MVP → Phase 1 → Phase 2. Small tasks mean no timeouts. Failed tasks auto-break into 2–4 subtasks and retry. If a task exhausts all retries, it goes to the Dead Letter Queue.

### PM Loop — Autonomous, Self-Extending
The most powerful mode. The PM Loop:
1. Reads a living `ROADMAP.md` (tracks `[x]` done, `[ ]` pending, `[!]` failed)
2. Picks the next pending item
3. Expands it into a precise, code-ready task via Groq
4. Dispatches to `crew-coder` with targeted send
5. Marks the item done
6. Every N completions (or when the roadmap is exhausted): calls Groq as a "product strategist," inspects the live output, generates 3–5 new roadmap items, appends them, keeps going

Start it once. It runs until you stop it. It generates its own work.

### Targeted Dispatch
Every task goes to exactly one agent by name. No races, no wasted calls.
```bash
node gateway-bridge.mjs --send crew-coder "Create server.js with Express and GET /health"
node gateway-bridge.mjs --send crew-qa "Write tests for server.js"
```

### Continuous Build
Section-aware build mode: checks the output directory for required sections after each round, dispatches targeted tasks for missing ones, and loops until everything is present. Good for websites and structured outputs.

### Shared Memory
A structured, multi-layer memory system that keeps the crew aligned across agents, sessions, and restarts:

- **Four active files**: `current-state.md` (project snapshot, in-progress tasks, next steps), `decisions.md` (durable choices in `DEC-000` format with owner, context, and revisit triggers), `agent-handoff.md` (last handoff timestamp, what was passed and to whom), `orchestration-protocol.md` (rules the entire crew agrees to follow)
- **Auto-bootstrap**: missing files are auto-created from structured templates before each task executes — no manual setup needed
- **Token budget enforcement**: 2,500 chars per file, 12,000 chars total; files load in priority order and truncate at the budget, keeping context windows clean
- **Mandatory protocol injection**: every agent call includes a `Mandatory memory protocol` header with current UTC and last handoff timestamp; if memory fails to load, the task aborts rather than running blind
- **Handoff tracking**: `getLastHandoffTimestamp()` tells each agent exactly when the last agent-to-agent handoff occurred, preventing stale context
- **Telemetry**: event logging for bootstrap, load errors, protocol violations, retry attempts, and RT events
- **Memory status CLI**: `node gateway-bridge.mjs --memory-status` inspects loaded files, char counts, and missing items

### Project Management
Multiple named projects, each with its own output directory and `ROADMAP.md`. Every project is registered in `orchestrator-logs/projects.json`. Resume any project at any time from the dashboard — the roadmap tracks exact state.

### Fault Tolerance
- Retry with exponential backoff (configurable max retries per agent)
- Auto-breakdown of failed tasks into subtasks
- Task leases (no task runs twice at the same time)
- Heartbeat monitoring (stale agents detected and restarted)
- Dead Letter Queue for tasks that exhaust all retries
- One-click DLQ replay from the dashboard

### Model-Agnostic
Swap models per agent, per project. Anthropic for coder, Groq for PM expansion, OpenAI for QA — whatever the task calls for. Configure in `~/.crewswarm/crewswarm.json`. No code changes.

---

## The Crew

| Agent | Alias | Role | Typical tasks |
|---|---|---|---|
| `crew-lead` | — | Chat commander | Conversational UI: roadmaps, dispatch, Q&A; uses Brave + codebase search for lookups |
| `crew-main` | — | Coordinator | Chat, triage, kick off orchestrators |
| `crew-pm` | Planner | Planning | Break requirements into tasks, assign agents |
| `crew-coder` | — | Implementation | Write code, create files, run commands |
| `crew-qa` | Tester | Quality | Add tests, validate behavior |
| `crew-fixer` | Debugger | Bug fixing | Debug failures, fix edge cases |
| `crew-security` | Guardian | Security | Vulnerability reviews, config hardening |

---

## Orchestration Modes

| Mode | Command | Best for |
|---|---|---|
| **Phased PDD** | `node phased-orchestrator.mjs --all "…"` | Larger or ambiguous work; auto-phases, auto-retries |
| **PM Loop** | `node pm-loop.mjs` | Continuous builds; self-generates tasks; runs forever |
| **Continuous Build** | `node continuous-build.mjs` | Websites and structured outputs with defined required sections |
| **Unified** | `node unified-orchestrator.mjs "…"` | Single-shot structured runs |
| **Targeted send** | `node gateway-bridge.mjs --send <agent> "…"` | One task, one agent, right now |
| **Dashboard** | `node scripts/dashboard.mjs` | All of the above with a UI |

---

## Dashboard

Runs at `localhost:4319`. Sections:

**Build**
- Textarea + "Enhance prompt" (Groq turns a rough idea into a clear requirement)
- "Run Build (phased)" — standard phased orchestrator
- "Build Until Done" — continuous build; loops until all sections exist
- "PM Loop" — Start / Stop / Dry run / View roadmap; shows running PID, live log
- Live build log and phased-dispatch progress readout

**Chat**
- Talk to **crew-lead** (conversational commander): ask questions, request roadmaps, dispatch tasks
- Same conversation syncs across dashboard, CrewChat menu bar app, and Telegram
- crew-lead uses Brave Search and codebase search when your message looks like a question or lookup

**Services**
- Live status for RT Message Bus, Agent Crew, **crew-lead**, Telegram Bridge, legacy gateway (optional), OpenCode Server, Dashboard
- Restart or stop any service from one place

**RT Messages**
- Live feed of every task, agent, and reply
- Shows who got what and what they returned

**DLQ**
- Failed tasks listed with agent, timestamp, error
- One-click Replay

**Projects**
- All registered projects with status, output dir, roadmap path
- "Resume PM Loop" and "View Roadmap" per project
- "New Project" to register a project directory

**Send**
- Dropdown: pick any agent or broadcast
- Direct message send

**Messaging**
- Telegram bridge config and message log; all Telegram messages route to crew-lead and share chat history with the dashboard.

---

## crew-lead & CrewChat

**crew-lead** is the conversational commander: the brain behind the dashboard Chat tab, the CrewChat menu bar app, and Telegram. You talk in natural language; crew-lead can draft project roadmaps (with @@PROJECT), dispatch tasks to agents (e.g. "have crew-coder add a health check"), and answer questions. When your message looks like a lookup or question, crew-lead automatically uses **Brave Search** (web) and **codebase search** (workspace files) to inject context into its reply.

**CrewChat** is a native macOS menu bar app: one click opens a popover with the same crew-lead conversation. Build it with `scripts/build-crew-chat.sh`; runs from `~/Applications/CrewChat.app`. Stays in sync with the dashboard and Telegram.

---

## SwiftBar (macOS Menu Bar)

- Green bolt = stack running, red = off — at a glance
- Start / Stop / Restart entire stack
- Per-agent restart or start
- "Open OpenCrewHQ Dashboard" with focus
- Per-agent direct message; broadcast
- RT Server and legacy gateway status
- Debug links: RT log, crew-lead log, plugin dir, CrewSwarm repo dir

Install: copy `contrib/swiftbar/openswitch.10s.sh` to SwiftBar plugins dir, `chmod +x`, reload.

---

## Use Cases

### 1. Build a feature from one sentence
Open the dashboard Build tab. Type a requirement (or click "Enhance prompt" to sharpen it). Hit "Build Until Done." The phased orchestrator runs MVP → Phase 1 → Phase 2; the crew assigns tasks, builds, tests, and verifies. Output lands in the project directory.

### 2. Continuous autonomous development — PM Loop
Point the PM Loop at a project. It reads the `ROADMAP.md`, ships features, marks them done, then — when it runs out of work — generates new roadmap items from the live state of the project and keeps going. No human in the loop. Stop it when you're satisfied.

### 3. Resume a failed project
Open the Projects tab in the dashboard. Every project shows its roadmap state and last known status. Click "Resume PM Loop" to pick up exactly where it left off. Failed items (`[!]`) are retried first.

### 4. Fix a bug and add tests
Run the unified orchestrator: "Fix the login bug in auth.js and add tests." PM assigns fix to `crew-fixer` and tests to `crew-qa`. Targeted dispatch — each agent gets exactly its task.

### 5. Control the crew from the menu bar
SwiftBar shows the stack status. One click to start or stop. Per-agent restart if one goes down. "Open Dashboard" to check progress. All from the macOS menu bar.

### 6. Recover from failures without losing work
Any task that fails after max retries goes to the Dead Letter Queue. Dashboard DLQ tab shows failure details. One-click Replay re-sends it. Nothing is permanently lost.

### 7. Keep the crew aligned across sessions
Shared memory holds current state, decisions, and handoff notes. Every agent call injects the same baseline. Restart tomorrow — the crew knows where it left off.

### 8. Swap models per task
Use Anthropic Claude for coding quality, Groq for PM task expansion speed, OpenAI for QA validation. Configure per agent in `~/.crewswarm/crewswarm.json`. No code changes, no restarts required.

---

## Technical Highlights (Short Bullets for Site)

- OpenCrew RT WebSocket bus: command, done, issues, status, assign topics
- Direct LLM per agent (Groq, Anthropic, OpenAI, NVIDIA, etc. in crewswarm.json), full tool execution
- PM Loop: ROADMAP.md → Groq task expansion → targeted send → mark done → self-extend
- PID file prevents duplicate PM Loop processes; dashboard detects and kills stale instances
- Phased PDD: MVP → Phase 1 → Phase 2; auto-breakdown of failed tasks into 2–4 subtasks
- Task leases + heartbeat monitoring: no duplicate work, no stale agents
- Dead Letter Queue + one-click replay
- Four control surfaces: CLI, web dashboard, CrewChat (menu bar), SwiftBar
- Shared memory: markdown files injected per task; persistent across sessions
- Project registry: multiple projects, per-project roadmap and output directory
- All models and agents configurable via JSON; no code changes to switch LLMs

---

## Website Section Map

| Section | Content source |
|---|---|
| **Hero** | Tagline, terminal animation showing PM → coder → files, primary CTA |
| **Social proof** | "Built locally. Real files. No simulated output." |
| **How it works** | 5 steps: Requirement → PM → Tasks → Crew → Files on disk |
| **Features** | Phased PDD, PM Loop, targeted dispatch, shared memory, fault tolerance, model-agnostic |
| **The crew** | Agent table with aliases, roles, typical tasks |
| **Use cases** | 6–8 scenarios from above |
| **Orchestration modes** | Mode comparison table |
| **Dashboard** | Screenshot/demo of dashboard UI |
| **Get started** | Prerequisites, quick start commands, links to docs |

---

*Use this doc as the single source for website copy, feature cards, use case descriptions, and technical bullets. Update it when new features ship.*
