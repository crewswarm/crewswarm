# Running CrewSwarm with Docker

## Quick start

```bash
docker compose up -d
open http://localhost:4319
```

That's it. Config and chat history persist in the `crewswarm-config` named volume.

---

## First-time setup

### 1. Authenticate engine CLIs on your host (once)

Docker containers inherit your auth tokens via read-only volume mounts. You only need to do this on the host — not inside the container.

```bash
claude          # Claude Code — opens browser for OAuth
cursor login    # Cursor CLI — opens browser for OAuth
codex login     # Codex — opens browser for OAuth
opencode        # OpenCode — set API key in dashboard → Providers
```

### 2. Add at least one API key

Open the dashboard at `http://localhost:4319` → **Providers** tab and add a key.
Groq is free and works immediately: https://console.groq.com/keys

### 3. Start the crew

```bash
docker compose up -d
```

---

## Volume layout

| Volume / Mount | What it stores |
|---|---|
| `crewswarm-config` → `/root/.crewswarm` | Config, API keys, agent prompts, **chat history** |
| `~/.claude` → `/root/.claude:ro` | Claude Code OAuth tokens |
| `~/.cursor` → `/root/.cursor:ro` | Cursor CLI auth |
| `~/.codex` → `/root/.codex:ro` | Codex OAuth tokens |
| `~/.config/opencode` → `/root/.config/opencode:ro` | OpenCode config |

**Never use `docker compose down -v`** unless you want to wipe all config and chat history. Plain `docker compose down` is safe — volumes persist.

---

## Useful commands

```bash
# Start all services
docker compose up -d

# Stop (preserves all data)
docker compose down

# View logs
docker compose logs -f

# Restart after a code change
docker compose up -d --build

# Open a shell inside the container
docker compose exec crewswarm bash

# Check health
curl http://localhost:4319/api/health
curl http://localhost:5010/health
```

---

## Engine passthrough in Docker

The engine CLI tools (Claude Code, Cursor, Codex, OpenCode) run on your **host machine** — they're mounted into the container as read-only binaries. Their auth tokens are mounted from your host's home directory.

This means:
- You authenticate once on the host (normal browser flow)
- The container reuses those tokens automatically
- No display or macOS session needed inside the container
- Engine binaries stay up to date with your host installs

If an engine binary lives somewhere other than `/usr/local/bin/`, update the path in `docker-compose.yml`.

---

## Verification checklist

After `docker compose up -d`, confirm these all pass:

```bash
# Dashboard API is up
curl -s http://localhost:4319/api/health | grep '"ok":true'

# Dashboard HTML is serving
curl -s http://localhost:4319 | grep -i "CrewSwarm Dashboard"

# crew-lead is up
curl -s http://localhost:5010/health | grep '"ok":true'

# Agent list is populated
curl -s http://localhost:4319/api/health | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d[\"agents\"])} agents online')"
```

Expected output: `{"ok":true, ...}`, `<title>CrewSwarm Dashboard</title>`, and `14+ agents online`.

---

## Troubleshooting

**Chat history disappeared after restart**
→ You likely ran `docker compose down -v`. Restore from `~/.crewswarm/` backup if you have one, or re-run `bash install.sh` to reinitialise.

**Engine passthrough fails inside container**
→ Check the binary mount path: `docker compose exec crewswarm which claude`
→ Check auth: `docker compose exec crewswarm claude --version`

**Port conflict**
→ Edit the port mappings in `docker-compose.yml` (left side is host port).

**Services not starting**
→ `docker compose logs crewswarm` — look for missing config or port conflicts.
