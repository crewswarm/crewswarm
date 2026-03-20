# MCP + CLI Integration

This repo has two related but different pieces:

1. `crew-cli` manages MCP client configs (`crew mcp ...`) for tools like Cursor/Claude/OpenCode.
2. `crew-cli` also serves its own MCP server in standalone mode.
3. The crewswarm gateway (parent repo) hosts the main MCP server at `http://127.0.0.1:5020/mcp`.

## Supported AI Coding Tools

crewswarm MCP integration works with:

| Tool | MCP Support | Config File | How to Add |
|------|------------|-------------|------------|
| **Cursor** | ✅ Yes | `~/.cursor/mcp.json` | Manual JSON edit |
| **Claude Code** | ✅ Yes | `~/.claude/mcp.json` | Manual JSON edit |
| **OpenCode** | ✅ Yes | `~/.config/opencode/mcp.json` | Manual JSON edit |
| **Codex CLI** | ✅ Yes | `~/.codex/mcp/config.json` | `codex mcp add` command |
| **Gemini CLI** | ✅ Yes | `.gemini/settings.json` | `gemini mcp add` command |

All 5 tools can connect to **both** crewswarm MCP servers (main gateway + crew-cli standalone).

## Two MCP Servers Available

### crew-cli MCP Server
**Port:** 4097 (configurable)  
**Start:** `crew serve --port 4097`  
**Tools:** 8 unified routing + sandbox tools

1. `crew_route_task` - L1→L2→L3 orchestration
2. `crew_execute_code` - Code generation with sandbox
3. `crew_sandbox_status` - Get pending changes
4. `crew_sandbox_preview` - Preview diffs
5. `crew_sandbox_apply` - Apply to working directory
6. `crew_sandbox_rollback` - Rollback changes
7. `crew_search_code` - Semantic search
8. `crew_list_models` - List available agents

### crewswarm Gateway MCP Server  
**Port:** 5020  
**Start:** `node scripts/mcp-server.mjs`  
**Tools:** 52 (7 core + 46 skills)

1. `dispatch_agent` - Send task to any agent
2. `list_agents` - List all 20 agents
3. `run_pipeline` - Multi-agent workflow
4. `chat_stinki` - Talk to crew-lead
5. `crewswarm_status` - System status
6. `smart_dispatch` - Auto-route to best agent
7. Dynamic `skill_*` tools (twitter, polymarket, etc.)

## Install In Gemini CLI (Google AI)

Gemini CLI supports MCP servers through HTTP transport with headers for authentication.

### Install Both MCP Servers in Gemini CLI

```bash
# 1) Ensure servers are running
# Main crewswarm: npm run restart-all (or: node scripts/mcp-server.mjs)
# crew-cli: crew serve --port 4097

# 2) Add crewswarm gateway MCP
gemini mcp add crewswarm "http://127.0.0.1:5020/mcp" \
  --transport http \
  --header "Authorization: Bearer $(cat ~/.crewswarm/crewswarm.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"rt\"][\"authToken\"])')" \
  --description "crewswarm main MCP server - 20 agents + 46 skills" \
  --trust

# 3) Add crew-cli MCP
gemini mcp add crew-cli "http://127.0.0.1:4097/mcp" \
  --transport http \
  --header "Authorization: Bearer $(cat ~/.crewswarm/crewswarm.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"rt\"][\"authToken\"])')" \
  --description "crew-cli MCP server - unified routing + sandbox" \
  --trust

# 4) Verify
gemini mcp list

# 5) Test with a prompt
gemini "list all available mcp tools" --allowed-mcp-server-names crewswarm crew-cli
```

**Configuration location:** `.gemini/settings.json` (project-level) or `~/.config/gemini-cli/settings.json` (user-level)

**Note:** Gemini CLI autodiscovers tools from configured MCP servers. The `--trust` flag bypasses confirmation prompts for tool calls from these servers.

## Install In Codex

### Install crew-cli MCP (Standalone Tools)

```bash
# 1) Start crew-cli server
crew serve --port 4097

# 2) Export token (if not already in .zshrc)
export CREWSWARM_TOKEN="$(node -e "const fs=require('fs');const os=require('os');const p=os.homedir()+'/.crewswarm/crewswarm.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(j.rt?.authToken||'')")"

# 3) Add to Codex
codex mcp add crew-cli --url "http://127.0.0.1:4097/mcp" --bearer-token-env-var CREWSWARM_TOKEN

# 4) Verify
codex mcp get crew-cli
```

### Install crewswarm Gateway MCP (All Agents + Skills)

```bash
# 1) Export token (if not already in .zshrc)
export CREWSWARM_TOKEN="$(node -e "const fs=require('fs');const os=require('os');const p=os.homedir()+'/.crewswarm/crewswarm.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(j.rt?.authToken||'')")"

# 2) Add MCP server
codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN

# 3) Verify
codex mcp get crewswarm
codex mcp list
```

## What Each MCP Server Provides

### Use crew-cli MCP When You Want:
- ✅ Unified L1→L2→L3 orchestration (single routing decision)
- ✅ Sandbox isolation (preview before apply)
- ✅ Session state management
- ✅ Semantic code search
- ✅ Standalone operation (no gateway needed)

### Use crewswarm Gateway MCP When You Want:
- ✅ Direct access to all 20 specialist agents
- ✅ All 46 skills (twitter, polymarket, elevenlabs, etc.)
- ✅ Multi-agent pipelines
- ✅ Chat with crew-lead (Stinki)
- ✅ Smart dispatch (auto-route to best agent)

### You Can Use Both!
Codex can have both MCP servers registered:
```bash
codex mcp list
# crew-cli   http://127.0.0.1:4097/mcp  ← Routing + sandbox
# crewswarm  http://127.0.0.1:5020/mcp  ← Agents + skills
```

## Install In crew-cli MCP Store (optional)

This syncs to local client config files for Cursor / Claude / OpenCode, and can also register Codex via `codex mcp add`:

```bash
crew mcp add crewswarm --url http://127.0.0.1:5020/mcp --bearer-token-env-var CREWSWARM_TOKEN
crew mcp add crewswarm --url http://127.0.0.1:5020/mcp --bearer-token-env-var CREWSWARM_TOKEN --client codex
crew mcp list
crew mcp doctor
```

## What `crew-cli` Serves vs MCP

`crew-cli` serves unified HTTP APIs via:

```bash
crew serve --port 4317
```

Those expose:

1. `/v1/*` endpoints (OpenAI-compatible + unified task endpoints)
2. `/mcp` endpoint (native MCP tools in `crew-cli`)

`--mode standalone` is still accepted as a compatibility alias, but `connected` is no longer supported.

Use gateway `:5020/mcp` for full crewswarm agents + skills.

## Troubleshooting

1. Check crew-cli MCP is up: `curl http://127.0.0.1:4097/mcp/health`
2. Check gateway MCP is up: `curl http://127.0.0.1:5020/health`
3. Check crew-lead is up: `curl http://127.0.0.1:5010/api/agents -H "Authorization: Bearer $CREWSWARM_TOKEN"`
4. Re-check MCP configs: `codex mcp get crew-cli` and `codex mcp get crewswarm`
5. Validate local config health: `crew mcp doctor`
6. Check token is set: `echo $CREWSWARM_TOKEN`
