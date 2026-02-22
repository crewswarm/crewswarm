# CrewSwarm Plugin for OpenClaw

Connects your OpenClaw agents to a local [CrewSwarm](https://github.com/jeffhobbs/CrewSwarm) multi-agent crew.

Your OpenClaw agents gain three new tools — `crewswarm_dispatch`, `crewswarm_status`, and `crewswarm_agents` — plus a `/crewswarm` slash command and Gateway RPC methods. **No LLM credentials are shared** — only a single auth token.

---

## What it does

| Surface | Description |
|---|---|
| `crewswarm_dispatch` | Agent tool — dispatch a task to any crew agent and block until done |
| `crewswarm_status` | Agent tool — poll status of a task by `taskId` |
| `crewswarm_agents` | Agent tool — list available agents |
| `/crewswarm <agent> <task>` | Slash command from any channel |
| `crewswarm.dispatch` | Gateway RPC |
| `crewswarm.status` | Gateway RPC |
| `crewswarm.agents` | Gateway RPC |

---

## Requirements

- [CrewSwarm](https://github.com/jeffhobbs/CrewSwarm) running locally (`npm run restart-all`)
- `crew-lead` reachable at `http://127.0.0.1:5010` (default)
- Your RT auth token from `~/.crewswarm/config.json → rt.authToken`

---

## Install

```bash
# From the CrewSwarm repo root:
openclaw plugins install ./contrib/openclaw-plugin
```

Or link for development (no copy, reflects edits immediately):

```bash
openclaw plugins install -l ./contrib/openclaw-plugin
```

Then restart the OpenClaw Gateway:

```bash
openclaw restart
```

---

## Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "crewswarm": {
        "enabled": true,
        "config": {
          "url":   "http://127.0.0.1:5010",
          "token": "<your RT auth token>"
        }
      }
    }
  }
}
```

Find your token:

```bash
cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])"
```

Optional config:

| Key | Default | Description |
|---|---|---|
| `url` | `http://127.0.0.1:5010` | crew-lead base URL |
| `token` | *(required)* | RT auth token |
| `pollIntervalMs` | `4000` | Status poll frequency |
| `pollTimeoutMs` | `300000` | Max wait time (5 min) |

---

## Usage

### From an OpenClaw agent conversation

Your OpenClaw agent will automatically call `crewswarm_dispatch` when it makes sense:

> "Use crew-coder to write a login endpoint with JWT auth"

Or explicitly:

> "Call crewswarm_dispatch with agent=crew-qa to audit my last change"

### Slash command (any channel — Telegram, WhatsApp, etc.)

```
/crewswarm crew-coder write /tmp/hello.js — a 10-line express hello world
/crewswarm crew-qa audit the last PR changes
/crewswarm crew-pm create a roadmap for the auth feature
/crewswarm                   ← lists available agents
```

### Gateway RPC (from scripts or other tools)

```bash
# Dispatch
openclaw rpc crewswarm.dispatch '{"agent":"crew-copywriter","task":"Write a tagline for CrewSwarm"}'

# Poll status
openclaw rpc crewswarm.status '{"taskId":"<uuid>"}'

# List agents
openclaw rpc crewswarm.agents
```

### Direct HTTP (no OpenClaw needed)

```bash
TOKEN="<your RT token>"

# List agents
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/agents

# Dispatch
curl -X POST http://127.0.0.1:5010/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crew-coder","task":"write hello.js"}'

# Poll
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/status/<taskId>
```

---

## Available agents (default crew)

| Agent | Role |
|---|---|
| `crew-coder` | Full-stack coding |
| `crew-coder-front` | Frontend specialist |
| `crew-coder-back` | Backend specialist |
| `crew-frontend` | UI/CSS |
| `crew-qa` | Testing & audit |
| `crew-fixer` | Bug fixing |
| `crew-pm` | Planning & roadmaps |
| `crew-security` | Security review |
| `crew-copywriter` | Writing & docs |
| `crew-github` | Git & PRs |
| `crew-main` | General purpose |

---

## How it works

```
OpenClaw agent
  → crewswarm_dispatch tool call
    → POST /api/dispatch (crew-lead HTTP, Bearer token)
      → RT WebSocket bus (port 18889)
        → target agent bridge (gateway-bridge.mjs)
          → LLM call (Mistral / Cerebras / DeepSeek / etc.)
          → tool execution (@@WRITE_FILE, @@RUN_CMD, etc.)
        → task.done event back on RT bus
      → crew-lead stores result
    → GET /api/status/:taskId (polled every 4s)
  ← result returned to OpenClaw agent
```

No LLM keys cross the boundary — CrewSwarm uses its own provider config. The only shared secret is the RT auth token.

---

## Troubleshooting

**"crew-lead unreachable"** — run `npm run restart-all` in the CrewSwarm repo.

**401 Unauthorized** — token mismatch. Re-copy from `~/.crewswarm/config.json → rt.authToken`.

**Task never completes** — check `/tmp/crew-lead.log` and the bridge log in `/tmp/`.

**Agent not found** — call `crewswarm_agents` to see the live agent list.
