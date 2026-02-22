# CrewSwarm

**One requirement in. Real files out.**

CrewSwarm is an open-source, PM-led multi-agent orchestration platform for software development. Write a requirement in plain language — the PM breaks it into tasks, dispatches each to the right specialist agent, retries failures, and ships working code to disk. No hallucinated success. No manual coordination.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)
[![Website](https://img.shields.io/badge/website-crewswarm.ai-blue)](https://crewswarm.ai)

---

## How it works

```
You: "Build a user auth API with tests"
        ↓
crew-lead   →  understands intent, dispatches to crew-pm
        ↓
crew-pm     →  plans MVP → Phase 1 → Phase 2
        ↓
crew-coder  →  writes src/auth/*.ts         (@@WRITE_FILE)
crew-qa     →  audits the output            (@@READ_FILE)
crew-fixer  →  patches any failures
crew-github →  commits to git
        ↓
Files on disk. Done.
```

No broadcast races. No duplicate work. Each agent gets exactly one task, from one dispatcher, with full context — and actually writes the files.

---

## Features

- **Real tool execution** — Agents write files (`@@WRITE_FILE`), read them (`@@READ_FILE`), make directories (`@@MKDIR`), and run commands (`@@RUN_CMD`). Not simulated. Real disk I/O.
- **PM-led orchestration** — Natural language requirement → PM breaks into phased tasks → targeted dispatch to the right specialist.
- **Task pipeline DSL** — crew-lead can emit `@@PIPELINE [{"agent":"crew-coder","task":"..."},{"agent":"crew-qa","task":"..."}]` to chain sequential tasks automatically, with each step's result injected into the next.
- **Shared memory** — `brain.md`, `session-log.md`, `current-state.md`, and `orchestration-protocol.md` are injected into every agent's prompt. crew-scribe watches completed tasks and writes LLM-generated summaries back to `session-log.md`. Agents write durable facts to `brain.md` via `@@BRAIN:` tags.
- **Fault tolerance** — Retry with backoff, task leases, heartbeat checks. Failed coding tasks auto-escalate to `crew-fixer`. After max retries, tasks land in the Dead Letter Queue for dashboard replay.
- **Command approval gate** — `@@RUN_CMD` calls from non-trusted agents pause and show an approval toast in the dashboard (Allow / Deny with 60s countdown). Pre-approve patterns like `npm *` or `node *` in **Settings → Command Allowlist** so common commands run without prompting. Dangerous commands (`rm -rf`, `sudo`, `curl | bash`) are always hard-blocked.
- **Token / cost tracking** — Every LLM call captures token usage. Dashboard **Settings** shows total calls, tokens, and estimated cost with per-model breakdown.
- **Telegram** — Full bidirectional Telegram integration. Each chat gets an isolated crew-lead session. Agents reply directly to the sender.
- **Four control surfaces** — CLI (`crew-cli`), web dashboard (port 4319), macOS SwiftBar menu bar, and Telegram.
- **Any model, any agent** — Each agent runs its own model. Mix OpenAI, Anthropic, Groq, Mistral, DeepSeek, Perplexity, or local Ollama. Switch without restarting.
- **PM Loop** — Autonomous mode: reads a `ROADMAP.md`, dispatches one item at a time, self-extends when the roadmap empties.
- **Standalone** — Runs without any third-party orchestration service. Bring your own API keys; direct LLM calls only.

---

## Quickstart

### Requirements

- Node.js 20+
- API key for at least one LLM provider (Groq, Anthropic, OpenAI, etc.)

### Install

```bash
git clone https://github.com/CrewSwarm/CrewSwarm
cd CrewSwarm
npm install
```

### Configure

Open the dashboard and go to the **Providers** tab to paste your API keys — no config file editing required:

```bash
npm run dashboard
# Open http://127.0.0.1:4319 → Providers tab
```

Keys are saved to `~/.crewswarm/config.json`. Or copy the example:

```bash
cp config.json.example ~/.crewswarm/config.json   # then fill in your keys
```

```json
{
  "providers": {
    "groq":      { "apiKey": "gsk_..." },
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai":    { "apiKey": "sk-..." }
  },
  "rt": {
    "authToken": "your-rt-bus-token"
  }
}
```

### Start the crew

```bash
# Start everything: RT bus + all agent bridges + crew-lead + crew-scribe + dashboard
npm run start-crew

# Or restart everything cleanly
npm run restart-all
```

Then open **http://127.0.0.1:4319** and go to the **🧠 Chat** tab.

### Run a build

```bash
# From the CLI
npm run crew-cli -- "Build a REST API for user authentication with JWT and tests"

# Or from the dashboard Chat tab — type naturally, crew-lead dispatches
```

### PM Loop (autonomous mode)

```bash
# Create a roadmap
node scripts/run.mjs "Build a SaaS MVP with auth, billing, and a dashboard"

# Start the loop — runs until every roadmap item is complete
PM_ROADMAP_FILE=./ROADMAP.md OPENCREW_OUTPUT_DIR=./output node pm-loop.mjs
```

---

## The Crew

| Agent | Role | Default model |
|---|---|---|
| `crew-lead` | Conversational commander — chat, dispatch, pipeline orchestration | Groq Llama 3.3 70B |
| `crew-pm` | Plans, breaks requirements into tasks, manages the roadmap | Perplexity Sonar Pro |
| `crew-coder` | General implementation — files, APIs, scripts | Claude 3.5 Sonnet |
| `crew-coder-front` | Frontend specialist — HTML, CSS, JS, UI | Claude 3.5 Sonnet |
| `crew-coder-back` | Backend specialist — APIs, DBs, server logic | Claude 3.5 Sonnet |
| `crew-qa` | Tests, validation, HTML/accessibility audits | Groq Llama 3.3 70B |
| `crew-fixer` | Debugging, patching failures — auto-escalated on coder failure | Groq Llama 3.3 70B |
| `crew-security` | Security audits, hardening | GPT-4o |
| `crew-github` | Git commits, PRs, branch management | GPT-4o-mini |
| `crew-copywriter` | Headlines, CTAs, product copy | Claude 3 Haiku |
| `crew-main` | General orchestration fallback | GPT-4o |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Control Surfaces                   │
│  crew-cli  │  Dashboard (4319)  │  SwiftBar │  TG  │
└────────────────────────┬────────────────────────────┘
                         │ HTTP (5010)
                    crew-lead.mjs
                 (chat · dispatch · pipelines)
                         │ WebSocket pub/sub
              ┌──────────┴──────────┐
              │  RT Bus (18889)     │  ← opencrew-rt-daemon.mjs
              └──────────┬──────────┘
                         │ task.assigned / command.run_task
         ┌───────┬───────┼───────┬────────┐
       crew-pm  crew-coder  crew-qa  crew-fixer  …
         │       │
         │    gateway-bridge.mjs (per-agent daemon)
         │       ├── loads shared memory (brain.md, etc.)
         │       ├── calls LLM directly (per-provider API)
         │       ├── executes @@WRITE_FILE / @@READ_FILE / @@MKDIR / @@RUN_CMD
         │       ├── approval gate for @@RUN_CMD
         │       └── retry → escalate to crew-fixer → DLQ
         │
      memory/           ← shared agent context (markdown)
      crew-scribe.mjs   ← polls done.jsonl, writes brain.md + session-log.md
      DLQ               ← failed task replay queue
```

---

## Control Surfaces

### CLI

```bash
npm run crew-cli -- "Build X"               # full PM orchestration
npm run crew-cli -- code "Create login"     # send to crew-coder
npm run crew-cli -- test "Test auth flow"   # send to crew-qa
npm run crew-cli -- fix "Debug timeout"     # send to crew-fixer
npm run crew-cli -- audit "Security review" # send to crew-security
npm run crew-cli -- --status                # check agent status
```

### Dashboard (http://127.0.0.1:4319)

| Tab | What it does |
|---|---|
| **💬 Sessions** | Active RT sessions and recent messages |
| **📡 RT Messages** | Live feed of every agent message on the bus |
| **🧠 Chat** | Conversational interface to crew-lead — type naturally, agents do work |
| **🔨 Build** | Start phased builds, run PM Loop, view output per project |
| **📁 Projects** | Create and manage projects, start/stop PM Loop per project |
| **🤖 Agents** | Assign models, edit system prompts, configure tool permissions |
| **⚙️ Providers** | Paste API keys for Groq, Anthropic, OpenAI, Perplexity, Mistral, DeepSeek, xAI, Ollama |
| **📡 Telegram** | Bot config, per-chatId conversation viewer, RT activity feed |
| **🔧 Services** | Restart/stop any managed service |
| **🛠 Settings** | Token usage + cost tracking, command allowlist (pre-approve `npm *`, `node *`, etc.) |
| **⚠️ DLQ** | Replay failed tasks |

### Telegram

```bash
# Start the Telegram bridge — chat with your crew from your phone
TELEGRAM_BOT_TOKEN=xxx npm run telegram
```

Each Telegram chatId gets its own isolated crew-lead session. Agent replies are forwarded back to the sender automatically.

### SwiftBar (macOS)

Install `contrib/swiftbar/openswitch.10s.sh` as a SwiftBar plugin for a menu bar status indicator and one-click agent controls.

---

## Configuration

### API keys & RT token

Managed through the dashboard **Providers** tab → saved to `~/.crewswarm/config.json`.

### Agent models

Set in the dashboard **Agents** tab or directly in `~/.openclaw/openclaw.json`:

```json
{
  "agents": [
    { "id": "crew-pm",    "model": "perplexity/sonar-pro" },
    { "id": "crew-coder", "model": "anthropic/claude-3-5-sonnet-20241022" },
    { "id": "crew-qa",    "model": "groq/llama-3.3-70b-versatile" }
  ]
}
```

### Command allowlist

Pre-approve shell commands in **Settings → Command Allowlist** so agents don't prompt for every `npm install`. Patterns use glob syntax (`npm *`, `node *`, `python *`). Hard-blocked commands (`rm -rf`, `sudo`, `curl | bash`) can never be allowlisted.

### Environment variables

| Variable | Description |
|---|---|
| `OPENCREW_RT_AUTH_TOKEN` | Auth token for the RT message bus |
| `OPENCREW_OUTPUT_DIR` | Where agents write files |
| `OPENCREW_RT_URL` | RT bus URL (default: `ws://127.0.0.1:18889`) |
| `CREW_LEAD_PORT` | crew-lead HTTP port (default: 5010) |

---

## Project structure

```
CrewSwarm/
├── crew-lead.mjs             # conversational commander + pipeline DSL + approval relay
├── crew-cli.mjs              # unified CLI
├── gateway-bridge.mjs        # agent runtime — RT bus ↔ direct LLM ↔ tool execution
├── telegram-bridge.mjs       # Telegram ↔ crew-lead bridge (per-chatId sessions)
├── pm-loop.mjs               # autonomous PM loop (reads ROADMAP.md)
├── unified-orchestrator.mjs  # PM → parser → dispatch pipeline
├── phased-orchestrator.mjs   # phased build orchestrator
├── continuous-build.mjs      # continuous round-based builder
├── scripts/
│   ├── dashboard.mjs         # web dashboard server (port 4319)
│   ├── start-crew.mjs        # spawn RT daemon + all agent bridges + crew-scribe
│   ├── crew-scribe.mjs       # memory daemon — polls done.jsonl, writes brain.md + session-log.md
│   ├── opencrew-rt-daemon.mjs # WebSocket message bus (port 18889)
│   ├── crewswarm-flow-test.mjs # end-to-end integration test
│   ├── dlq-replay.mjs        # DLQ replay helper
│   ├── openswitchctl         # control script (status, send, start/stop, DLQ replay)
│   └── run.mjs               # canonical entrypoint
├── memory/                   # shared agent context (markdown files)
│   ├── brain.md              # persistent project knowledge — agents append @@BRAIN: facts
│   ├── session-log.md        # LLM-written task summaries from crew-scribe
│   ├── orchestration-protocol.md
│   └── agents.md
├── docs/                     # guides and references
├── contrib/swiftbar/         # macOS SwiftBar plugin
└── website/                  # crewswarm.ai marketing site
```

---

## Docs

- [System Architecture](docs/SYSTEM-ARCHITECTURE.md)
- [Orchestrator Guide](docs/ORCHESTRATOR-GUIDE.md)
- [Phased Builds (PDD)](docs/PHASED-ORCHESTRATOR.md)
- [Agent Setup](docs/OPENCLAW-AGENTS-SETUP.md)
- [Model Recommendations](docs/MODEL-RECOMMENDATIONS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [SwiftBar Plugin](contrib/swiftbar/README.md)

---

## License

MIT — use it, fork it, build on it.

---

<p align="center">
  <a href="https://crewswarm.ai">crewswarm.ai</a> · 
  <a href="https://github.com/CrewSwarm/CrewSwarm">GitHub</a>
</p>
