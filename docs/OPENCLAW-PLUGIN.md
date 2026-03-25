# OpenClaw Plugin

CrewSwarm ships an official [OpenClaw](https://github.com/openclaw/openclaw) plugin that lets any OpenClaw agent dispatch tasks to your local crew.

## What it adds

| Surface | Description |
|---|---|
| `crewswarm_dispatch` | Agent tool — dispatch to any crew agent, blocks until done |
| `crewswarm_status` | Agent tool — poll task status by taskId |
| `crewswarm_agents` | Agent tool — list available agents |
| `/crewswarm` | Slash command from any channel (Telegram, WhatsApp, Discord, etc.) |
| `crewswarm.dispatch` | Gateway RPC method |
| `crewswarm.status` | Gateway RPC method |
| `crewswarm.agents` | Gateway RPC method |

## Install

```bash
# From CrewSwarm repo root
openclaw plugins install ./contrib/openclaw-plugin

# Or link for development (edits reflected immediately)
openclaw plugins install -l ./contrib/openclaw-plugin

# Restart gateway
openclaw restart
```

## Configure

Add to your `openclaw.json` (usually `~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "crewswarm": {
        "enabled": true,
        "config": {
          "url": "http://127.0.0.1:5010",
          "token": "<your RT auth token>"
        }
      }
    }
  }
}
```

Find your token:

```bash
cat ~/.crewswarm/crewswarm.json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).rt?.authToken||'not set'))"
```

## How it works

```
OpenClaw agent
  -> crewswarm_dispatch tool call
    -> POST crew-lead /api/dispatch (Bearer token)
      -> RT WebSocket bus (port 18889)
        -> target agent bridge (gateway-bridge.mjs)
          -> LLM + tool execution
        -> task.done event
      -> crew-lead stores result
    -> GET /api/status/:taskId (polled)
  <- result returned to OpenClaw agent
```

No LLM keys cross the boundary. CrewSwarm uses its own provider config. The only shared secret is the RT auth token.

## Agent discovery

OpenClaw discovers CrewSwarm agents from directories in `~/.openclaw/agents/`. CrewSwarm's install script creates these automatically. The plugin also provides `crewswarm_agents` which queries the live agent list from crew-lead at runtime.

## Publishing to ClawHub

The plugin can be published for other OpenClaw users:

```bash
cd contrib/openclaw-plugin
npm publish --access public
```

Users install with:

```bash
openclaw plugins install crewswarm-openclaw-plugin
```

Published on npm: [crewswarm-openclaw-plugin](https://www.npmjs.com/package/crewswarm-openclaw-plugin)

## Files

```
contrib/openclaw-plugin/
  index.ts                  # Plugin source (tools, commands, RPC, health)
  openclaw.plugin.json      # Plugin manifest
  package.json              # npm package config
  README.md                 # Full usage docs
  skills/crewswarm/
    SKILL.md                # Teaches OpenClaw AI when/how to use CrewSwarm
```

See `contrib/openclaw-plugin/README.md` for detailed usage, examples, and troubleshooting.
