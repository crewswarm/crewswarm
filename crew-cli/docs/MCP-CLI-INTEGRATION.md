# MCP + CLI Integration

This repo has two related but different pieces:

1. `crew-cli` manages MCP client configs (`crew mcp ...`) for tools like Cursor/Claude/OpenCode.
2. The CrewSwarm gateway (parent repo) hosts the actual MCP server at `http://127.0.0.1:5020/mcp`.

## Available CrewSwarm MCP Tools

From `scripts/mcp-server.mjs` in the parent repo:

1. `dispatch_agent`
2. `list_agents`
3. `run_pipeline`
4. `chat_stinki`
5. `crewswarm_status`
6. `smart_dispatch`
7. Dynamic `skill_*` tools (one per installed skill)

## Install In Codex

```bash
# 1) export CrewSwarm RT token as env var
export CREWSWARM_TOKEN="$(node -e "const fs=require('fs');const os=require('os');const p=os.homedir()+'/.crewswarm/config.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(j.rt?.authToken||'')")"

# 2) add MCP server
codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN

# 3) verify
codex mcp get crewswarm
codex mcp list
```

If it already exists, remove/re-add:

```bash
codex mcp remove crewswarm
codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN
```

## Install In crew-cli MCP Store (optional)

This syncs to local client config files (`~/.cursor/mcp.json`, `~/.claude/mcp.json`, `~/.config/opencode/mcp.json`):

```bash
crew mcp add crewswarm --url http://127.0.0.1:5020/mcp --bearer-token-env CREWSWARM_TOKEN
crew mcp list
crew mcp doctor
```

## What `crew-cli` Serves vs MCP

`crew-cli` serves unified HTTP APIs via:

```bash
crew serve --mode standalone
crew serve --mode connected
```

Those expose `/v1/*` endpoints (OpenAI-compatible + unified task endpoints), not a native MCP server.

Use gateway `:5020/mcp` for MCP tools.

## Troubleshooting

1. Check gateway MCP is up: `curl http://127.0.0.1:5020/health`
2. Check crew-lead is up: `curl http://127.0.0.1:5010/api/agents -H "Authorization: Bearer $CREWSWARM_TOKEN"`
3. Re-check MCP config: `codex mcp get crewswarm`
4. Validate local config health: `crew mcp doctor`
