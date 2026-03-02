# MCP Quick Reference - All 5 AI Tools

## 🎯 Quick Answer: Yes, Gemini CLI has MCP support!

Google announced official MCP support in December 2025. Gemini CLI (v0.31.0+) supports MCP servers through HTTP transport with header-based authentication.

## Installation Summary

| Tool | Command to Add CrewSwarm MCP | Config File |
|------|------------------------------|-------------|
| **Gemini CLI** | `gemini mcp add crewswarm "http://127.0.0.1:5020/mcp" --transport http --header "Authorization: Bearer <TOKEN>" --trust` | `.gemini/settings.json` |
| **Codex CLI** | `codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN` | `~/.codex/mcp/config.json` |
| **Cursor** | Manual JSON edit | `~/.cursor/mcp.json` |
| **Claude Code** | Manual JSON edit | `~/.claude/mcp.json` |
| **OpenCode** | Manual JSON edit | `~/.config/opencode/mcp.json` |

## Your Token

```bash
# Get it
cat ~/.crewswarm/config.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["rt"]["authToken"])'

# Your token: REMOVED_CREWSWARM_TOKEN
# Already set in ~/.zshrc as: export CREWSWARM_TOKEN="..."
```

## What You Get

### CrewSwarm Gateway MCP (port 5020)
- 20 specialist agents (crew-coder, crew-qa, crew-pm, crew-security, etc.)
- 46 skills (twitter, polymarket, elevenlabs, code-review, roadmap-planning, etc.)
- 1 pipeline observability tool (pipeline_metrics) ✨
- Total: **53 tools**

### crew-cli MCP (port 4097)
- Unified L1→L2→L3 routing
- Sandbox isolation (preview/apply/rollback)
- Semantic code search
- Total: **8 tools**

**Grand Total: 61 MCP tools** available in all 5 AI coding environments.

## Verify Setup

```bash
# Check servers are running
curl http://127.0.0.1:5020/health
curl http://127.0.0.1:4097/mcp/health

# Test Gemini CLI
gemini "list all mcp tools" --allowed-mcp-server-names crewswarm crew-cli

# Test Codex CLI
codex mcp list

# Test Cursor/Claude/OpenCode
# (open the app, start chat, type "use dispatch_agent to...")
```

## Full Docs

- **Complete setup guide:** `/Users/jeffhobbs/Desktop/CrewSwarm/MCP-COMPLETE-SETUP.md`
- **CLI integration details:** `/Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/docs/MCP-CLI-INTEGRATION.md`
- **Main documentation:** `/Users/jeffhobbs/Desktop/CrewSwarm/AGENTS.md`

---

**Status:** ✅ All 5 AI tools configured
- Cursor ✅
- Claude Code ✅
- OpenCode ✅
- Codex CLI ✅
- Gemini CLI ✅
