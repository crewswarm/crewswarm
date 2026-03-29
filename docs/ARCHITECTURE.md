# crewswarm Architecture

System diagram, port map, and request flow.

## Port map

| Service | Port | Description |
|---------|------|-------------|
| Dashboard (Vite frontend + API) | 4319 | Web UI, chat, agents, settings |
| crew-lead | 5010 | Chat, dispatch, pipelines, @@STOP/@@KILL |
| RT message bus | 18889 | WebSocket pub/sub for agent coordination |
| Code Engine | 4096 | OpenCode / Claude Code / Cursor / Codex |
| MCP + OpenAI API | 5020 | Optional — Cursor, Claude Code, OpenCode MCP |
| **Vibe** | 3333 | Full IDE — Monaco editor, file tree, project-aware chat (`npm run vibe:start` or `npm run vibe`) |
| **Vibe watch server** | 3334 | CLI → Vibe live reload WebSocket (`npm run vibe:watch`) |
| WhatsApp bridge HTTP | 5015 | WhatsApp send API (`WA_HTTP_PORT`, default 5015) |

## System diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                       Control Surfaces                           │
│  Dashboard (4319)  │  SwiftBar  │  Telegram  │  WhatsApp  │  CLI │
└────────────────────────────┬─────────────────────────────────────┘
                              │ HTTP (5010)
                         crew-lead.mjs
                   (chat · dispatch · pipelines · @@STOP/@@KILL)
                              │ WebSocket pub/sub
                 ┌────────────┴────────────┐
                 │  RT Bus (18889)          │  ← opencrew-rt-daemon.mjs
                 └────────────┬────────────┘
                              │ task.assigned / command.run_task
        ┌───────┬─────────────┼───────┬──────────┐
      crew-pm  crew-coder  crew-qa  crew-fixer  crew-github  …
                 │
              gateway-bridge.mjs (per-agent daemon)
                 ├── loads shared memory (brain.md, etc.)
                 ├── calls LLM directly (per-provider API)
                 ├── executes @@WRITE_FILE / @@READ_FILE / @@RUN_CMD
                 ├── approval gate for @@RUN_CMD
                 ├── Code Engine :4096 (OpenCode / Claude Code / Cursor / Codex)
                 └── retry → escalate to crew-fixer → DLQ

  MCP + OpenAI API (5020)  ← mcp-server.mjs (optional)
     ├── Cursor MCP · Claude Code MCP · OpenCode MCP · Codex MCP
     └── Open WebUI · LM Studio · Aider (/v1/chat/completions)

  memory/           ← shared agent context (markdown)
  crew-scribe.mjs   ← polls done.jsonl, writes brain.md + session-log.md
  DLQ               ← failed task replay queue
```

## Request flow

1. **User** → Dashboard Chat or CLI → HTTP to crew-lead (5010)
2. **crew-lead** → parses intent, may call crew-pm for planning
3. **crew-lead** → publishes `task.assigned` to RT bus (18889)
4. **gateway-bridge** (per agent) → claims task, calls LLM, executes tools
5. **Result** → published back to RT bus → crew-lead → user

## Dispatch / result schemas

- **task.assigned**: `{ taskId, agentId, task, payload }`
- **task.done**: `{ taskId, agentId, result, error? }`
- **command.run_task**: used for pipeline execution

See [ORCHESTRATOR-GUIDE.md](ORCHESTRATOR-GUIDE.md) for pipeline DSL and wave execution.

## API Reference

The full OpenAPI 3.1 specification is at [`crew-cli/docs/openapi.unified.v1.json`](../crew-cli/docs/openapi.unified.v1.json) — 142 endpoints across Dashboard (`:4319`), crew-lead (`:5010`), and Vibe (`:3333`).

Import into Postman, Insomnia, or any OpenAPI-compatible tool:
```bash
# View in browser
open crew-cli/docs/openapi.unified.v1.json

# Generate a client
npx openapi-generator-cli generate -i crew-cli/docs/openapi.unified.v1.json -g typescript-fetch -o sdk/
```

Key endpoint groups:
- `/api/dispatch`, `/api/status/:taskId` — task orchestration
- `/api/agents`, `/api/agents-config/*` — agent management
- `/api/crew-lead/chat` — conversational chat
- `/api/pm-loop/*` — autonomous PM loop control
- `/api/skills/*` — skill management and execution
- `/api/providers/*` — LLM provider configuration
- `/api/services/*` — service health and control
