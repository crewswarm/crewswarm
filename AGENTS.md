# CrewSwarm — AI Setup Guide

> This file is read automatically by Cursor, Claude Code, Codex, and most AI coding assistants.
> If a user says "set this up", "install CrewSwarm", or "get me started" — follow the steps below.

---

## What is CrewSwarm?

A local multi-agent AI orchestration system. A crew of specialist AI agents
(coder, QA, PM, fixer, security, copywriter, etc.) that collaborate on tasks
via a real-time WebSocket bus. You interact through a web dashboard, Telegram,
or by chatting directly with crew-lead.

**Ports when running:**
| Service | Port |
|---|---|
| Dashboard | 4319 |
| crew-lead (chat + dispatch) | 5010 |
| RT message bus | 18889 |

---

## Setup — do this when the user first opens the repo

### Step 1 — Prerequisites

```bash
node --version   # needs 20+
npm --version
```

If Node.js is missing:
```bash
brew install node   # macOS
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Run the installer

```bash
bash install.sh
```

The installer will:
- Create `~/.crewswarm/` config directory
- Bootstrap `config.json` (RT auth token), `crewswarm.json` (agent models), `cmd-allowlist.json`
- Optionally start all services and open the dashboard in the browser
- Optionally set up SwiftBar menu bar plugin (macOS)
- Optionally set up Telegram bot

### Step 4 — Add at least one API key

Open the dashboard at `http://127.0.0.1:4319` → **Providers** tab.

**Groq is free and works immediately:** https://console.groq.com/keys

Paste the key next to `groq`. That's enough to run the whole crew.

Other supported providers: Mistral, Cerebras, DeepSeek, Perplexity, OpenAI,
Anthropic, xAI, Google, NVIDIA.

### Step 5 — Start the crew

```bash
npm run restart-all
```

Or from the dashboard → Services tab → Start All.

### Step 6 — Talk to the crew

Open `http://127.0.0.1:4319` → **Chat** tab and start typing.

---

## Key files to know

| File | What it does |
|---|---|
| `crew-lead.mjs` | Conversational commander, HTTP server on :5010 |
| `gateway-bridge.mjs` | Per-agent daemon — calls LLM, executes tools |
| `scripts/dashboard.mjs` | Web UI on :4319 |
| `telegram-bridge.mjs` | Telegram integration |
| `scripts/crew-scribe.mjs` | Memory maintenance (summaries, lessons) |
| `~/.crewswarm/crewswarm.json` | Agent model assignments + provider API keys |
| `~/.crewswarm/config.json` | RT auth token |
| `~/.openclaw/agent-prompts.json` | System prompt per agent |

---

## Agent roster

| Agent ID | Role |
|---|---|
| `crew-coder` | Full-stack coding |
| `crew-coder-front` | Frontend / UI |
| `crew-coder-back` | Backend / API |
| `crew-frontend` | CSS / design |
| `crew-qa` | Testing & audit |
| `crew-fixer` | Bug fixing |
| `crew-pm` | Planning & roadmaps |
| `crew-security` | Security review |
| `crew-copywriter` | Writing & docs |
| `crew-github` | Git & PRs |
| `crew-main` | General purpose |

---

## Agent tools (@@TOOL syntax)

Agents communicate tool calls inline in their replies:

```
@@WRITE_FILE /path/to/file.js
...file contents...
@@END_FILE

@@READ_FILE /path/to/file.js

@@MKDIR /path/to/dir

@@RUN_CMD ls -la
```

`@@RUN_CMD` is gated by `~/.crewswarm/cmd-allowlist.json` and requires dashboard approval for unlisted commands.

---

## Dispatching tasks

From the dashboard chat or Telegram:
```
dispatch crew-coder to write a login endpoint with JWT
have crew-qa audit the last PR
```

Or pipeline multiple agents:
```
@@PIPELINE [
  {"wave":1, "agent":"crew-coder", "task":"Write /src/auth.ts — JWT login"},
  {"wave":2, "agent":"crew-qa",    "task":"Test the auth endpoint"}
]
```

Tasks in the same `wave` run in parallel. Higher waves wait for lower waves.

---

## External API (for integrations)

crew-lead exposes a REST API for external tools. Auth: Bearer token from `~/.crewswarm/config.json → rt.authToken`.

```bash
TOKEN=$(cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")

# List agents
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/agents

# Dispatch a task
curl -X POST http://127.0.0.1:5010/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crew-coder","task":"write hello.js"}'

# Poll for result
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/status/<taskId>
```

---

## Common commands

```bash
npm run restart-all          # restart everything
node scripts/start-crew.mjs  # restart just the agent bridges
node crew-lead.mjs           # restart just crew-lead

# Check logs
tail -f /tmp/crew-lead.log
tail -f /tmp/opencrew-rt-daemon.log
```

---

## Troubleshooting

**Agents not responding** — run `npm run restart-all`, check logs in `/tmp/`.

**No API key error** — open dashboard → Providers tab, add a Groq key (free).

**crew-lead not reachable** — `curl http://127.0.0.1:5010/health` — if 404, restart with `node crew-lead.mjs`.

**File not written by agent** — agent's tool permissions come from `~/.crewswarm/crewswarm.json → agents[].tools.crewswarmAllow` or role defaults in `gateway-bridge.mjs → AGENT_TOOL_ROLE_DEFAULTS`.
