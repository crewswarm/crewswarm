# Runtime

Engines, agent execution paths, and runtime identity.

## Execution modes (per agent)

| Mode | How it works | Best for |
|------|--------------|----------|
| **OpenCode** | `opencode run` — full file editing, bash, session memory | Coding agents |
| **Cursor CLI** | `agent -p … --model <id>` (default **`composer-2-fast`** if no `cursorCliModel`; override `CREWSWARM_CURSOR_MODEL`) | Complex reasoning — **requires working local `agent` + auth**; see [CURSOR-CLI.md](CURSOR-CLI.md) |
| **Claude Code** | `claude -p` — full workspace context | Large refactors |
| **crew-cli** | `codex exec --sandbox workspace-write --json` | OpenAI Codex |
| **Direct API** | Agent calls LLM directly, parses `@@TOOL` markers | Fast/cheap agents |

Switch per-agent from **Dashboard → Settings → Engines** or `~/.crewswarm/crewswarm.json`.

## Agent execution path

1. User → crew-lead (HTTP 5010)
2. crew-lead → RT bus (task.assigned)
3. gateway-bridge (per agent) → claims task
4. LLM call or engine invocation (OpenCode/Cursor/Claude/Codex)
5. Tool execution → `@@WRITE_FILE`, `@@READ_FILE`, `@@RUN_CMD`
6. Result → RT bus → crew-lead → user

## Runtime identity

- Each agent runs as a separate `gateway-bridge.mjs` process
- Model ID from `crewswarm.json` → `provider/model-id`
- Tool permissions from `crewswarmAllow` or role defaults in `gateway-bridge.mjs`

## Ouroboros loop (optional)

When `opencodeLoop: true` or `CREWSWARM_ENGINE_LOOP=1`:

- LLM decomposes task into STEPs
- Each STEP sent to engine (OpenCode/Cursor/Claude/Codex)
- Results fed back until DONE or `CREWSWARM_ENGINE_LOOP_MAX_ROUNDS` (default 10)
