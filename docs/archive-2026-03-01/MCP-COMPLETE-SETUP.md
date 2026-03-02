# CrewSwarm MCP Setup - All AI Tools Configured ✅

**Status:** All 5 major AI coding tools now have access to CrewSwarm MCP servers.

## What You Have

### Two MCP Servers Running

1. **CrewSwarm Gateway MCP** (main repo)
   - Port: `5020`
   - URL: `http://127.0.0.1:5020/mcp`
   - Tools: 52 (20 agents + 46 skills)
   - Start: `npm run restart-all` or `node scripts/mcp-server.mjs`

2. **crew-cli MCP** (standalone)
   - Port: `4097`
   - URL: `http://127.0.0.1:4097/mcp`
   - Tools: 8 (routing + sandbox)
   - Start: `crew serve --mode standalone --port 4097`

### Authentication

**Token:** `REMOVED_CREWSWARM_TOKEN`
- Stored in: `~/.crewswarm/config.json` → `rt.authToken`
- Environment variable: `CREWSWARM_TOKEN` (set in `~/.zshrc`)

## Configured AI Tools

### ✅ Cursor IDE
**Config:** `~/.cursor/mcp.json`
```json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": {
        "Authorization": "Bearer REMOVED_CREWSWARM_TOKEN"
      }
    },
    "crew-cli": {
      "url": "http://127.0.0.1:4097/mcp",
      "headers": {
        "Authorization": "Bearer REMOVED_CREWSWARM_TOKEN"
      }
    }
  }
}
```
**Restart required:** Yes, after editing config

### ✅ Claude Code (Desktop App)
**Config:** `~/.claude/mcp.json`
```json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": {
        "Authorization": "Bearer REMOVED_CREWSWARM_TOKEN"
      }
    },
    "crew-cli": {
      "url": "http://127.0.0.1:4097/mcp",
      "headers": {
        "Authorization": "Bearer REMOVED_CREWSWARM_TOKEN"
      }
    }
  }
}
```
**Restart required:** Yes, after editing config

### ✅ OpenCode
**Config:** `~/.config/opencode/mcp.json`
```json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": {
        "Authorization": "Bearer REMOVED_CREWSWARM_TOKEN"
      }
    },
    "crew-cli": {
      "url": "http://127.0.0.1:4097/mcp",
      "headers": {
        "Authorization": "Bearer REMOVED_CREWSWARM_TOKEN"
      }
    }
  }
}
```
**Restart required:** Yes, after editing config

### ✅ Codex CLI
**Config:** `~/.codex/mcp/config.json` (managed by `codex mcp` commands)

**Setup commands:**
```bash
# Token must be in environment
export CREWSWARM_TOKEN="REMOVED_CREWSWARM_TOKEN"

# Add both servers
codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN
codex mcp add crew-cli --url "http://127.0.0.1:4097/mcp" --bearer-token-env-var CREWSWARM_TOKEN

# Verify
codex mcp list
```

**Token persistence:** Added to `~/.zshrc` so it's always available

### ✅ Gemini CLI (Google AI)
**Config:** `.gemini/settings.json` (project-level, auto-created)

**Setup commands:**
```bash
# Add both servers with HTTP transport
gemini mcp add crewswarm "http://127.0.0.1:5020/mcp" \
  --transport http \
  --header "Authorization: Bearer REMOVED_CREWSWARM_TOKEN" \
  --description "CrewSwarm main MCP server - 20 agents + 46 skills" \
  --trust

gemini mcp add crew-cli "http://127.0.0.1:4097/mcp" \
  --transport http \
  --header "Authorization: Bearer REMOVED_CREWSWARM_TOKEN" \
  --description "crew-cli MCP server - unified routing + sandbox" \
  --trust

# Verify
gemini mcp list

# Test
gemini "list all available mcp tools" --allowed-mcp-server-names crewswarm crew-cli
```

**Location:** `.gemini/settings.json` in current project directory
**Verified:** ✅ Successfully connected and listed all 60 tools (52 from gateway + 8 from crew-cli)

## Total Available Tools

### From CrewSwarm Gateway (53 tools)

**Core orchestration (7):**
1. `dispatch_agent` - Send task to any specialist agent
2. `list_agents` - List all 20 agents and their status
3. `run_pipeline` - Multi-agent workflow execution
4. `chat_stinki` - Talk to crew-lead (natural language dispatch)
5. `crewswarm_status` - Live system status and telemetry
6. `smart_dispatch` - Auto-route task to best agent
7. `stop_all` - Emergency stop all pipelines
8. `pipeline_metrics` - Get QA and context optimization metrics ✨ NEW

**Skills (46):**
- `skill_twitter_post`, `skill_polymarket_trade`, `skill_elevenlabs_tts`
- `skill_fly_deploy`, `skill_webhook_post`, `skill_zeroeval_benchmark`
- `skill_code_review`, `skill_api_design`, `skill_threat_model`
- `skill_roadmap_planning`, `skill_problem_statement`
- `skill_ai_seo`, `skill_positioning_icp`, `skill_gtm_metrics`
- ... and 31 more

### From crew-cli Standalone (8 tools)

1. `crew_route_task` - L1→L2→L3 unified orchestration
2. `crew_execute_code` - Code generation with sandbox isolation
3. `crew_sandbox_status` - Get current pending changes
4. `crew_sandbox_preview` - Preview diffs before applying
5. `crew_sandbox_apply` - Apply sandbox changes to working directory
6. `crew_sandbox_rollback` - Rollback applied changes
7. `crew_search_code` - Semantic code search
8. `crew_list_models` - List available models and agents

## How to Use

### From Cursor/Claude/OpenCode
Open any project, start a chat, and reference MCP tools:
```
Use dispatch_agent to send this task to crew-coder
```

Tools autocomplete in the AI chat interface when typing.

### From Codex CLI
```bash
# Sandbox-isolated code execution
codex exec --mcp crew-cli crew_execute_code --json '{"code":"console.log(\"hello\")"}'

# Dispatch to specialist agent
codex exec --mcp crewswarm dispatch_agent --json '{"agent":"crew-qa","task":"audit login.js"}'

# Smart routing (auto-selects best agent)
codex exec --mcp crewswarm smart_dispatch --json '{"task":"fix bug in payment.js"}'
```

### From Gemini CLI
```bash
# Natural language prompts with MCP autodiscovery
gemini "use crew_execute_code to write a hello world function"

# Specify which MCP servers to use
gemini "dispatch a security audit to crew-security" \
  --allowed-mcp-server-names crewswarm

# Test specific tool
gemini "call skill_twitter_post with text 'Hello from Gemini+CrewSwarm!'" \
  --allowed-mcp-server-names crewswarm
```

## Health Checks

```bash
# Check CrewSwarm gateway MCP
curl http://127.0.0.1:5020/health
# {"ok":true,"server":"crewswarm-mcp","version":"1.0.0","agents":20,"skills":46}

# Check crew-cli MCP
curl http://127.0.0.1:4097/mcp/health
# {"ok":true,"server":"crew-cli-mcp","mode":"standalone","version":"1.0.0","tools":8}

# Check which processes are listening
lsof -i :5020 -i :4097
```

## Troubleshooting

### Tool not found
**Symptom:** `Tool "dispatch_agent" not found`
**Fix:** 
1. Check server is running: `curl http://127.0.0.1:5020/health`
2. Restart AI tool (Cursor/Claude/OpenCode)
3. For Codex: `codex mcp list` to verify registration
4. For Gemini: `gemini mcp list` to verify registration

### Unauthorized (401)
**Symptom:** `401 Unauthorized` or `Missing auth token`
**Fix:**
1. Check token: `cat ~/.crewswarm/config.json | grep authToken`
2. For Codex: `echo $CREWSWARM_TOKEN` (should match)
3. For Gemini: Check `.gemini/settings.json` has correct Bearer token
4. For Cursor/Claude/OpenCode: Verify `mcp.json` has correct Bearer token

### Connection refused
**Symptom:** `ECONNREFUSED` or `Connection refused`
**Fix:**
1. Start main MCP: `cd /Users/jeffhobbs/Desktop/CrewSwarm && npm run restart-all`
2. Start crew-cli MCP: `crew serve --mode standalone --port 4097`
3. Verify: `lsof -i :5020 -i :4097` should show both listening

### Gemini CLI not seeing tools
**Symptom:** `gemini mcp list` shows "No MCP servers configured"
**Fix:**
1. Check if config exists: `cat .gemini/settings.json`
2. Re-add servers (see Gemini CLI setup commands above)
3. Try project-level vs user-level: `gemini mcp add ... --scope user`

## Next Steps

Now that all 5 AI tools have MCP access:

1. **Try it:** Open Cursor/Claude/OpenCode and start a chat with an MCP tool call
2. **Test Gemini:** `gemini "dispatch a code review to crew-qa for login.js"`
3. **Build automation:** Chain MCP tools in Codex scripts
4. **Extend skills:** Add new skills to `~/.crewswarm/skills/`
5. **Monitor usage:** Check dashboard at `http://127.0.0.1:4319`

## Documentation

- Full MCP integration guide: `/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/docs/MCP-CLI-INTEGRATION.md`
- OpenAI wrapper spec: `/Users/jeffhobbs/Desktop/CrewSwarm/docs/MCP-OPENAI-WRAPPER-SPEC.md`
- Main repo docs: `/Users/jeffhobbs/Desktop/CrewSwarm/AGENTS.md`

---

**All 5 AI tools configured and tested** ✅
- Cursor ✅
- Claude Code ✅
- OpenCode ✅
- Codex CLI ✅
- Gemini CLI ✅

Total: **61 MCP tools** available across all platforms (53 from gateway + 8 from crew-cli).

Latest additions:
- `pipeline_metrics` - QA efficiency and context optimization metrics (added Mar 1, 2026)
