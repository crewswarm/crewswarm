# crewswarm

**Local-first AI orchestration for people who want real files, real tools, and real control.**

crewswarm is an open-source AI workspace for software development. It combines multi-agent orchestration, project-aware memory, local tool execution, chat surfaces, and editor/MCP integrations into one stack you can run yourself.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)
[![Website](https://img.shields.io/badge/website-crewswarm.ai-blue)](https://crewswarm.ai)

![crewswarm Dashboard](website/dashboard-agents.webp)

---

## What crewswarm is

Most AI dev tools are just a chat box bolted onto an editor.

**crewswarm** is different:

- **Local-first** — run it on your own machine
- **Real execution** — agents write files, run commands, and operate on actual projects
- **Multi-agent** — planner, coder, QA, fixer, security, GitHub, and more
- **Persistent context** — memory and session history survive beyond one chat
- **Multiple control surfaces** — dashboard, CLI, Telegram, SwiftBar, MCP/editor integrations
- **Model-flexible** — use Groq, OpenAI, Anthropic, Gemini, Mistral, DeepSeek, xAI, Ollama, and more

It is built for:
- solo builders
- AI-native dev teams
- local-first users who do not want SaaS lock-in
- people building real software with agent workflows, not toy demos

---

## Why it matters

Most “agent” tools still fake the important part.

They can talk. They can plan. They can look clever.

Then they fall apart when it is time to:
- write real files
- work across multiple steps
- keep project memory
- coordinate multiple specialists
- run locally without disappearing into someone else’s cloud

crewswarm is built to handle actual execution.

---

## Quickstart

### Requirements

- Node.js 20+
- At least one LLM provider key for best results  
  - Groq is the fastest free starting point: [console.groq.com](https://console.groq.com)

### Install

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
bash install.sh
```

**Fresh machine shortcut:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/install.sh)
```

### Start
```bash
npm run doctor
npm run restart-all
```

Then open:
`http://127.0.0.1:4319`

Add your provider key in the Providers tab, then go to Chat and start giving tasks.

---

### First example

In the dashboard chat, type:
> Build a REST API for user authentication with JWT and tests

**crewswarm will:**
- route the request through `crew-lead`
- break it down through `crew-pm`
- dispatch implementation to the right coding agent
- run QA / validation
- optionally hand off Git tasks

This is not simulated. It works against real files and your real local workspace.

---

### Headless / non-interactive install

For Cursor, Codex, CI, or remote shell setups:
```bash
CREWSWARM_SETUP_MCP=1 \
CREWSWARM_START_NOW=1 \
bash install.sh --non-interactive
```

Optional flags:
- `CREWSWARM_BUILD_CREWCHAT=1`
- `CREWSWARM_SETUP_TELEGRAM=1`
- `CREWSWARM_SETUP_WHATSAPP=1`
- `CREWSWARM_ENABLE_AUTONOMOUS=1`

---

## Core capabilities

**Real tool execution**
Agents can write files, read files, create directories, run commands, and work inside a real project folder.

**PM-led orchestration**
Natural language requests are broken into structured tasks and routed to the right agent.

**Shared memory**
Project context persists through files like `brain.md`, `session-log.md`, `current-state.md`, and `orchestration-protocol.md`.

**Fault tolerance**
Retries, escalation to fixer agents, task leases, and dead-letter replay support are built in.

**Command approval gate**
Potentially risky shell commands require approval before execution.

**Multi-engine support**
Route work through different engines and environments, including Codex, Claude Code, Cursor, Gemini, OpenCode, and `crew-cli`.

**Multiple control surfaces**
Use crewswarm from the web dashboard, CLI, Telegram, macOS SwiftBar, or MCP/editor integrations.

---

## Why crewswarm vs other frameworks

| Feature | crewswarm | LangChain / LangGraph | AutoGen | CrewAI |
|---|---|---|---|---|
| Real file writes | ✅ | ⚠️ | ⚠️ | ⚠️ |
| PM-led planning | ✅ | ❌ | ❌ | ⚠️ |
| Persistent memory | ✅ | ⚠️ | ❌ | ⚠️ |
| Local-first | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Built-in dashboard | ✅ | ❌ | ❌ | ❌ |
| Telegram / messaging bridges | ✅ | ❌ | ❌ | ❌ |
| Easy local startup | ✅ | ⚠️ | ⚠️ | ⚠️ |

---

## Main components

| Component | Purpose |
|---|---|
| `crew-lead` | conversational command layer and dispatcher |
| `crew-pm` | planning, task breakdown, roadmap management |
| `crew-coder` | implementation |
| `crew-qa` | testing and validation |
| `crew-fixer` | debugging and repair |
| `crew-security` | security review |
| `crew-github` | Git and repo actions |
| `dashboard` | browser-based control surface |
| `crew-cli` | command-line interface |
| `crew-scribe` | memory and task summarization |

---

## Architecture

```
Dashboard / Vibe / crew-cli / Telegram / SwiftBar / MCP
                  |
              crew-lead
                  |
               RT Bus
                  |
     -----------------------------------
     |        |        |       |       |
   crew-pm  coder     qa    fixer   github
                  |
           local tools + models
                  |
          real files, commands, memory
```

---

## Commands

- **Preflight:** `npm run doctor`
- **Start the stack:** `npm run restart-all`
- **Launch Dashboard only:** `npm run dashboard`
- **Run CLI task:** `crew exec "Build a REST API with JWT auth and tests"`
- **Static smoke** (no services): `npm run smoke:static`
- **Live smoke** (stack must be running): `npm run smoke`
- **Health check:** `npm run health`
- **Release preflight:** `npm run release:check`

---

## Configuration

crewswarm stores config under your local `~/.crewswarm` directory.

Typical settings include provider API keys, agent model assignments, RT auth token, output path, and command allowlist.

The easiest way to manage config is through the dashboard.

**Example agent config**
```json
{
  "agents": [
    { "id": "crew-pm", "model": "perplexity/sonar-pro" },
    { "id": "crew-coder", "model": "anthropic/claude-sonnet-4-20250514" },
    { "id": "crew-qa", "model": "groq/llama-3.3-70b-versatile" }
  ]
}
```

---

## Project structure

```
crewswarm/
├── crew-lead.mjs
├── crew-cli/
├── gateway-bridge.mjs
├── telegram-bridge.mjs
├── pm-loop.mjs
├── unified-orchestrator.mjs
├── phased-orchestrator.mjs
├── continuous-build.mjs
├── scripts/
├── memory/
├── docs/
├── contrib/swiftbar/
└── website/
```

---

## Docs

- `docs/CANONICAL/README.md`
- `docs/ARCHITECTURE.md`
- `docs/ORCHESTRATOR-GUIDE.md`
- `docs/SETUP-NEW-AGENTS.md`
- `docs/MODEL-RECOMMENDATIONS.md`
- `docs/TROUBLESHOOTING.md`

## Related repos

- `crew-cli` — standalone CLI for task execution and orchestration

---

## License

MIT
