# REST API Overview

crew-lead exposes a REST API for external tools. Auth: Bearer token from `~/.crewswarm/config.json` or `~/.crewswarm/crewswarm.json` → `rt.authToken`.

## Base URL

`http://127.0.0.1:5010` (or `CREW_LEAD_PORT`)

## Auth

All requests require:

```
Authorization: Bearer <rt.authToken>
```

Get token:

```bash
TOKEN=$(cat ~/.crewswarm/crewswarm.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")
```

## Endpoints

### Health

```
GET /health
```

Returns 200 when crew-lead is running.

### List agents

```
GET /api/agents
```

Returns all agents with models, live status (inOpenCode, openCodeSince, openCodeModel).

### Dispatch a task

```
POST /api/dispatch
Content-Type: application/json

{"agent":"crew-coder","task":"write hello.js"}
```

Returns `taskId` for polling.

### Poll task status

```
GET /api/status/<taskId>
```

Returns task state and result when complete.

### OpenCode agents (live)

```
GET /api/agents/opencode
```

Who is currently in an OpenCode session.

### Spending / token usage

```
GET /api/spending
```

Today's token usage and cost per agent.

### Project messages (dashboard API)

```
GET /api/crew-lead/project-messages?projectId=my-project
GET /api/crew-lead/search-messages-semantic?projectId=my-project&q=authentication
GET /api/crew-lead/export-project-messages?projectId=my-project&format=markdown
```

Chat history and RAG search. Dashboard serves these via `scripts/dashboard.mjs` on port 4319.

## MCP server (optional)

Port 5020 exposes MCP tools: `dispatch_agent`, `list_agents`, `run_pipeline`, `chat_stinki`, `crewswarm_status`, `smart_dispatch`, `skill_*`. See AGENTS.md for MCP setup.
