# Quick Start: Adding New Agents

**Last Updated:** 2026-02-26

## TL;DR
CrewSwarm agents are already "plugins" — just edit JSON and restart. No code changes needed.

## Prerequisites
- Node.js 20+ and dependencies: `npm install`
- CrewSwarm running (`npm run restart-all`)

## Steps to Add a New Agent

### 1. Edit Agent Config
**File:** `~/.crewswarm/crewswarm.json`

Add to the `agents` array:
```json
{
  "id": "crew-researcher",
  "model": "groq/llama-3.3-70b-versatile"
}
```

Optionally add a system prompt to `~/.crewswarm/agent-prompts.json`:
```json
{ "researcher": "You are crew-researcher. Search the web and summarize findings clearly." }
```

**Popular models:**
- `groq/llama-3.3-70b-versatile` (free, fast, great tools)
- `groq/moonshotai/kimi-k2-instruct-0905` (free, strong coder)
- `xai/grok-3-mini` (paid, powerful reasoning)
- `deepseek/deepseek-chat` (paid, cheap, strong)

**Tool permissions** (optional, via `crewswarmAllow`):
```json
{
  "id": "crew-researcher",
  "model": "groq/llama-3.3-70b-versatile",
  "tools": {
    "crewswarmAllow": ["read_file", "web_search", "web_fetch"]
  }
}
```

Available permissions: `read_file`, `write_file`, `mkdir`, `run_cmd`, `git`, `dispatch`.

### 2. Restart Agent Bridges
```bash
npm run restart-all
```

Or just restart the bridges: `node scripts/start-crew.mjs`

### 3. Test New Agent
Open the dashboard at `http://127.0.0.1:4319` → Chat tab:
```
dispatch crew-researcher to find the top 5 Rust async frameworks
```

Or via API:
```bash
TOKEN=$(cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")
curl -X POST http://127.0.0.1:5010/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crew-researcher","task":"find the top 5 Rust async frameworks"}'
```

## Example: Adding a "Researcher" Agent

**`~/.crewswarm/crewswarm.json`:**
```json
{
  "id": "crew-researcher",
  "model": "perplexity/sonar",
  "tools": {
    "crewswarmAllow": ["read_file", "write_file", "web_search", "web_fetch"]
  }
}
```

**`~/.crewswarm/agent-prompts.json`:**
```json
{ "researcher": "You are crew-researcher. Search the web, read docs, and return well-structured summaries. Always cite sources." }
```

**Restart:** `npm run restart-all`

**Test:** Chat → `dispatch crew-researcher to summarize the latest news on LLM evals`

## Why NOT Extract to Plugin?

1. **Already configurable** - CrewSwarm is designed for JSON config
2. **No code duplication** - One gateway, many agents
3. **Shared infrastructure** - Memory, validation, telemetry
4. **Simpler maintenance** - One codebase, one deploy

## When to Create a Separate Plugin?

Only if you need:
- **Custom tool implementations** (requires custom agent code)
- **Different gateway protocol** (not WebSocket)
- **Standalone distribution** (no extra dependencies)

For 99% of use cases: **Just add agents to crewswarm.json!**

