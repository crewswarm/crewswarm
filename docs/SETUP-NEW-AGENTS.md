# Adding New Agents

How to add a custom agent to crewswarm.

## 1. Add agent config

Edit `~/.crewswarm/crewswarm.json`:

```json
{
  "id": "crew-researcher",
  "model": "perplexity/sonar-pro"
}
```

Format is `provider/model-id`. The provider must have an API key in the `providers` block.

## 2. Add system prompt

Edit `~/.crewswarm/agent-prompts.json`. The key is the bare agent name without `crew-` prefix:

```json
{
  "researcher": "You are crew-researcher. Search the web and summarize findings. Be concise and cite sources."
}
```

## 3. Restart bridges

```bash
pkill -f "gateway-bridge.mjs"
node scripts/start-crew.mjs
```

Or use **Dashboard → Services → Restart agents**.

The new agent is auto-registered and appears in the Agents tab.

## 4. Optional: tool permissions

By default, role-based defaults apply. To override, add `crewswarmAllow`:

```json
{
  "id": "crew-researcher",
  "model": "perplexity/sonar-pro",
  "tools": {
    "crewswarmAllow": ["read_file", "write_file"]
  }
}
```

Available permissions: `read_file`, `write_file`, `append_file`, `mkdir`, `run_cmd`, `git`, `dispatch`, `skill`, `define_skill`, `telegram`, `web_search`, `web_fetch`, `browser`. See `lib/tools/executor.mjs` → `CREWSWARM_TOOL_NAMES`.

## 5. Optional: add a provider

If your agent uses a new provider, add it under `providers` in `crewswarm.json`:

```json
{
  "providers": {
    "my-provider": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.my-provider.com/v1"
    }
  }
}
```

Then use `my-provider/model-name` in the agent's `model` field.

## Registering for dispatch

Agents are auto-registered when their bridge starts. To allow an agent to emit `@@DISPATCH` (coordination role), add it to the coordinator list in `lib/agent-registry.mjs`. Most agents only receive tasks; coordinators (crew-pm, crew-main, crew-orchestrator) can delegate.
