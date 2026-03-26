# How to Add a New Agent

CrewSwarm agents are entries in `~/.crewswarm/crewswarm.json`. Each agent gets its own model, tools, and personality.

## Quick: Dashboard UI

1. Open the Dashboard (`http://localhost:4319`)
2. Go to the **Agents** tab
3. Click **+ Add Agent**
4. Fill in: ID, name, emoji, model, tools
5. Click **Create**

The agent appears immediately — no restart needed.

## Manual: Edit crewswarm.json

Add an entry to the `agents` array in `~/.crewswarm/crewswarm.json`:

```json
{
  "id": "crew-devops",
  "name": "DevOps",
  "emoji": "🚀",
  "model": "groq/llama-3.3-70b-versatile",
  "role": "Infrastructure, CI/CD, deployment"
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `id` | Unique ID, must start with `crew-` (auto-prefixed if not) |
| `model` | `provider/model-id` format (e.g. `groq/llama-3.3-70b-versatile`) |

### Optional fields

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `emoji` | Single emoji for dashboard/logs |
| `role` | Short description of what this agent does |
| `fallbackModel` | Backup model if primary fails |

## Agent Tools

Each agent gets a set of allowed tools. Configure via the Dashboard (Agents tab → expand agent → Tools) or in `~/.crewswarm/agent-tools/<agent-id>.json`:

```json
{
  "tools": ["write_file", "read_file", "mkdir", "run_cmd", "browser"]
}
```

Available tools: `write_file`, `read_file`, `mkdir`, `run_cmd`, `browser`, `dispatch`, `web_search`, `web_fetch`, `git`, `skill`, `telegram`.

## Custom System Prompt

Add a prompt file at `prompts/<agent-id>.md` in the repo root. The agent loads this as its system prompt. See existing files in `prompts/` for examples.

Alternatively, set a custom prompt via the Dashboard (Agents tab → expand agent → System Prompt).

## Gateway Bridge

Once configured, the agent automatically gets a gateway bridge process that:
- Connects to the RT bus on port 18889
- Listens for dispatched tasks
- Executes them using the configured model + engine
- Returns results

No additional setup needed — `scripts/start-crew.mjs` spawns bridges for all configured agents.

## Dispatching to Your Agent

```bash
# From the dashboard chat
@crew-devops set up GitHub Actions for this repo

# Via API
curl -X POST http://127.0.0.1:5010/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crew-devops","task":"Set up CI/CD pipeline"}'

# Via crew-cli
crew chat --agent crew-devops "Deploy to staging"
```
