# MCP Tools Setup Complete

## ✅ All Configured

All three AI coding tools now have access to both MCP servers:

### Cursor
**Config:** `~/.cursor/mcp.json`
```json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    },
    "crew-cli": {
      "url": "http://127.0.0.1:4097/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Claude Code  
**Config:** `~/.claude/mcp.json`
- Same format as Cursor

### OpenCode
**Config:** `~/.config/opencode/mcp.json`
- Same format as Cursor

## Available Tools

### From crewswarm (:5020) - 52 tools
- `dispatch_agent` - Send task to any of 20 agents
- `list_agents` - List all available agents
- `run_pipeline` - Multi-agent workflow
- `chat_stinki` - Talk to crew-lead
- `crewswarm_status` - System status
- `smart_dispatch` - Auto-route to best agent
- Plus 46 `skill_*` tools (twitter, polymarket, elevenlabs, etc.)

### From crew-cli (:4097) - 8 tools
- `crew_route_task` - L1→L2→L3 unified orchestration
- `crew_execute_code` - Code generation with sandbox
- `crew_sandbox_status` - Sandbox state
- `crew_sandbox_preview` - Preview changes
- `crew_sandbox_apply` - Apply to working dir
- `crew_sandbox_rollback` - Rollback
- `crew_search_code` - Semantic search
- `crew_list_models` - List agents

**Total: 60 MCP tools** across both servers

## How to Use

### In Cursor
1. **Restart Cursor** (required to load MCP config)
2. Use Composer (Cmd+I) or Chat
3. Ask: "Use list_agents MCP tool to show all agents"

### In Claude Code
1. **Restart Claude Code** if it's running
2. Chat with Claude
3. Ask: "Use the crewswarm_status MCP tool"

### In OpenCode  
1. **Restart OpenCode** if it's running
2. Use chat interface
3. Ask: "Use crew_sandbox_status to check my sandbox"

## Verify Servers Are Running

```bash
# Check main MCP server
curl http://127.0.0.1:5020/health

# Check crew-cli MCP server
curl http://127.0.0.1:4097/mcp/health
```

## Start Servers

If either server isn't running:

```bash
# Start main MCP server
node scripts/mcp-server.mjs &

# Start crew-cli MCP server
crew serve --mode standalone --port 4097 &
```

## Token

The token is set in `~/.zshrc`:
```bash
export CREWSWARM_TOKEN="REMOVED_CREWSWARM_TOKEN"
```

Open a new terminal or run `source ~/.zshrc` to activate.

## Troubleshooting

If MCP tools don't appear:
1. Verify both servers are running (curl commands above)
2. Check config files exist and are valid JSON
3. Restart the AI tool (Cursor/Claude/OpenCode)
4. Check token is set: `echo $CREWSWARM_TOKEN`

## Status

- ✅ Cursor MCP config: Updated
- ✅ Claude Code MCP config: Updated  
- ✅ OpenCode MCP config: Updated
- ✅ Main MCP server: Running (PID 3854)
- ✅ crew-cli MCP server: Running (PID 58463)
- ✅ Auth token: Set in ~/.zshrc

**Everything is ready!** Just restart your AI coding tool to access all 60 MCP tools.
