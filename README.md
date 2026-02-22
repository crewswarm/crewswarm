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
crew-pm   →  plans MVP → Phase 1 → Phase 2
        ↓
crew-coder    →  writes src/auth/*.ts
crew-qa       →  writes tests, validates
crew-fixer    →  patches failures
crew-security →  audits the output
        ↓
Files on disk. Done.
```

No broadcast races. No duplicate work. Each agent gets exactly one task, from one dispatcher, with full context.

---

## Features

- **PM-led orchestration** — Natural language requirement → PM breaks into phased tasks → targeted dispatch.
- **Phased builds (PDD)** — MVP → Phase 1 → Phase 2. Failed tasks auto-decompose into subtasks and retry.
- **Shared memory** — Persistent markdown files injected into every agent call. The crew stays aligned across sessions and restarts.
- **Fault tolerance** — Retry with backoff, task leases, heartbeat checks. After max retries, tasks land in the Dead Letter Queue for dashboard replay.
- **Four control surfaces** — CLI (`crew-cli`), web dashboard, macOS SwiftBar menu bar, and Telegram.
- **Any model, any agent** — Each agent runs its own model. Mix OpenAI, Anthropic, Groq, Mistral, DeepSeek, Perplexity, or local Ollama. Switch without restarting.
- **PM Loop** — Autonomous mode: reads a `ROADMAP.md`, dispatches one item at a time, self-extends when the roadmap empties.
- **Standalone** — Runs without any third-party orchestration service. Bring your own API keys; direct LLM calls only.

---

## Quickstart

### Requirements

- Node.js 20+
- API key for at least one LLM provider (Groq, Anthropic, OpenAI, etc.)
- [OpenClaw](https://github.com/openclaw/openclaw) *(optional — enables additional gateway routing and macOS integrations)*

### Install

```bash
git clone https://github.com/CrewSwarm/CrewSwarm
cd CrewSwarm
npm install
```

### Configure

Open the dashboard and go to the **Providers** tab to paste your API keys — no config file editing required:

```bash
node scripts/dashboard.mjs
# Open http://127.0.0.1:4319 → Providers tab
```

Keys are saved to `~/.crewswarm/config.json`. Or create it manually:

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
# Start all agent bridges
node scripts/start-crew.mjs

# Check status
node crew-cli.mjs --status
```

### Run a build

```bash
# One-shot: send a requirement through the full PM → agents pipeline
node crew-cli.mjs "Build a REST API for user authentication with JWT and tests"

# Or kick it off from the dashboard Build tab
node scripts/dashboard.mjs
# Open http://127.0.0.1:4319
```

### PM Loop (autonomous mode)

```bash
# Create a roadmap first
node scripts/run.mjs "Build a SaaS MVP with auth, billing, and a dashboard"
# ^ PM creates ROADMAP.md automatically

# Start the loop — runs until every roadmap item is done
PM_ROADMAP_FILE=./ROADMAP.md OPENCREW_OUTPUT_DIR=./output node pm-loop.mjs
```

---

## The Crew

| Agent | Role | Default model |
|---|---|---|
| `crew-pm` | Plans, breaks requirements into tasks, manages the roadmap | Perplexity Sonar Pro |
| `crew-coder` | General implementation — files, APIs, scripts | Claude 3.5 Sonnet |
| `crew-coder-front` | Frontend specialist — HTML, CSS, JS, UI | Claude 3.5 Sonnet |
| `crew-coder-back` | Backend specialist — APIs, DBs, server logic | Claude 3.5 Sonnet |
| `crew-qa` | Tests, validation, HTML/accessibility audits | Groq Llama 3.3 70B |
| `crew-fixer` | Debugging, patching failures from QA | Groq Llama 3.3 70B |
| `crew-security` | Security audits, hardening | GPT-4o |
| `crew-github` | Git commits, PRs, branch management | GPT-4o-mini |
| `crew-copywriter` | Headlines, CTAs, product copy | Claude 3 Haiku |
| `crew-main` | Coordination, triage, Telegram gateway | GPT-4o |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Control Surfaces                   │
│  crew-cli  │  Dashboard (4319)  │  SwiftBar │  TG  │
└────────────────────────┬────────────────────────────┘
                         │
                  gateway-bridge.mjs
                   (per-agent daemon)
                         │
              ┌──────────┴──────────┐
              │    CrewSwarm RT     │  ← WebSocket message bus (18889)
              └──────────┬──────────┘
                         │ direct LLM calls (per provider API)
         ┌───────┬───────┼───────┬────────┐
      crew-pm  crew-coder  crew-qa  crew-fixer  …
         │
      ROADMAP.md  ← phased task ledger
      memory/     ← shared context (markdown)
      DLQ         ← failed task replay queue
```

**Optional:** [OpenClaw](https://github.com/openclaw/openclaw) can be installed alongside CrewSwarm for additional LLM gateway routing, WhatsApp/iMessage integration, and macOS-native agent controls.

---

## Control Surfaces

### CLI

```bash
node crew-cli.mjs "Build X"               # full PM orchestration
node crew-cli.mjs code "Create login"     # send to crew-coder
node crew-cli.mjs test "Test auth flow"   # send to crew-qa
node crew-cli.mjs fix "Debug timeout"     # send to crew-fixer
node crew-cli.mjs audit "Security review" # send to crew-security
node crew-cli.mjs --status                # check agent status
```

### Dashboard (http://127.0.0.1:4319)

- **Build** — start phased builds, run PM Loop, view output per project
- **RT Messages** — live feed of every agent message
- **Projects** — create and manage projects, start/stop PM Loop per project
- **Providers** — paste API keys for Groq, Anthropic, OpenAI, Perplexity, Mistral, DeepSeek, xAI, Ollama
- **Agents** — assign models, edit system prompts, spin up new agents
- **Services** — restart/stop any managed service (RT bus, bridges, Telegram)
- **Send** — send a task directly to any agent
- **DLQ** — replay failed tasks

### Telegram

```bash
# Start the Telegram bridge — chat with your crew from your phone
TELEGRAM_BOT_TOKEN=xxx node telegram-bridge.mjs
```

### SwiftBar (macOS)

Install `contrib/swiftbar/openswitch.10s.sh` as a SwiftBar plugin for a menu bar status indicator and one-click agent controls.

---

## Configuration

Keys and tokens are managed through the dashboard **Providers** tab and saved to `~/.crewswarm/config.json`.

### Agent models

Agent model assignments live in `~/.openclaw/openclaw.json` (if using OpenClaw) or can be set directly in the dashboard **Agents** tab. Example:

```json
{
  "agents": [
    { "id": "crew-pm",    "model": "perplexity/sonar-pro" },
    { "id": "crew-coder", "model": "anthropic/claude-3-5-sonnet-20241022" },
    { "id": "crew-qa",    "model": "groq/llama-3.3-70b-versatile" }
  ]
}
```

### Environment variables

| Variable | Description |
|---|---|
| `OPENCREW_RT_AUTH_TOKEN` | Auth token for the RT message bus |
| `OPENCREW_OUTPUT_DIR` | Where agents write files |
| `OPENCREW_RT_URL` | RT bus URL (default: `ws://127.0.0.1:18889`) |
| `OPENCREW_OPENCODE_ENABLED` | Set to `0` to disable OpenCode routing |

---

## Project structure

```
CrewSwarm/
├── crew-cli.mjs              # unified CLI
├── gateway-bridge.mjs        # agent runtime — RT bus ↔ direct LLM calls
├── pm-loop.mjs               # autonomous PM loop
├── unified-orchestrator.mjs  # PM → parser → dispatch pipeline
├── phased-orchestrator.mjs   # phased build orchestrator
├── continuous-build.mjs      # continuous round-based builder
├── telegram-bridge.mjs       # Telegram ↔ RT bus bridge
├── scripts/
│   ├── dashboard.mjs         # web dashboard server
│   ├── start-crew.mjs        # spawn all agent bridges
│   └── run.mjs               # canonical entrypoint
├── memory/                   # shared agent memory (markdown)
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
