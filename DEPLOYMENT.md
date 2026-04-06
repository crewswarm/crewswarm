# crewswarm Deployment Guide

Three paths: npm for most users, source for contributors, Docker for servers and teams.

---

## 1. npm Install (Recommended)

Fastest way to get running. Installs the CLI globally and starts the full stack.

```bash
npm install -g crewswarm
crewswarm
```

Dashboard: http://localhost:4319
Vibe IDE: http://localhost:3333

Add at least one API key in Dashboard → Providers. Groq is free at console.groq.com/keys.

---

## 2. Source Install (Contributors)

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
bash install.sh
npm run restart-all
```

This clones the repo, installs dependencies, builds the dashboard and crew-cli, and starts all services.

---

## 3. Docker Install (Servers & Teams)

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

This auto-installs Docker if needed, clones the repo, builds the image, configures security, and starts services.

### Manual Docker

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
docker compose up -d
```

### What Docker exposes

| Service | Port | Description |
|---------|------|-------------|
| Dashboard | 4319 | Web control plane — agents, providers, models, build logs |
| crew-lead | 5010 | Chat commander — routes tasks to agents |
| RT Message Bus | 18889 | Real-time agent communication backbone |
| Code Engine | 4096 | Coding execution server for engine lanes |
| MCP Server | 5020 | 64 tools via JSON-RPC for MCP clients |
| Vibe IDE | 3333 | Browser workspace — Monaco, terminal, chat |
| Vibe Watch | 3334 | CLI → Vibe live reload relay |

### Secure Docker (production)

Use the hardened compose file for production deployments:

```bash
docker compose -f docker-compose.secure.yml up -d
```

This adds the 5-layer security model:
1. **Docker isolation** — read-only root filesystem, tmpfs for /tmp
2. **AppArmor profile** — kernel-enforced mandatory access control
3. **Network firewall** — blocks cloud metadata endpoints (AWS/GCP credential theft)
4. **Command allowlist** — dashboard approval for new shell commands
5. **Non-root execution** — UID 1000, no new privileges, all capabilities dropped

Details: https://crewswarm.ai/security.html

### Docker volumes

```yaml
volumes:
  # Config, API keys, agent prompts, chat history — the only persistent state
  - crewswarm-config:/root/.crewswarm

  # Workspace for CLI output and Vibe file browsing
  - ./workspace:/workspace:rw
```

---

## 4. Configuration

### Config file

crewswarm stores configuration in `~/.crewswarm/crewswarm.json`:

```json
{
  "providers": {
    "groq": { "apiKey": "gsk_..." },
    "openai": { "apiKey": "sk-..." },
    "anthropic": { "apiKey": "sk-ant-..." },
    "xai": { "apiKey": "xai-..." },
    "deepseek": { "apiKey": "sk-..." }
  },
  "agents": [
    { "id": "crew-pm", "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-coder", "model": "anthropic/claude-sonnet-4-20250514" },
    { "id": "crew-qa", "model": "google/gemini-2.5-flash" }
  ]
}
```

Or set API keys via environment variables:

```bash
export GROQ_API_KEY=gsk_...
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export XAI_API_KEY=xai-...
export DEEPSEEK_API_KEY=sk-...
export GEMINI_API_KEY=...
```

### OAuth (no API keys needed)

Claude and OpenAI support OAuth — log in once, no keys required:
- Claude: `claude auth login` (from Claude Code CLI)
- OpenAI: `codex auth login` (from Codex CLI)

crew-cli detects these automatically.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RT_PORT` | 18889 | RT message bus port |
| `RT_AUTH_TOKEN` | auto | Bus authentication token |
| `CREWSWARM_OUTPUT_PATH` | ~/.crewswarm/output | Agent output directory |
| `CREWSWARM_WORKSPACE` | cwd | Default workspace path |
| `CREW_EFFORT` | auto | Force effort level (low/medium/high) |
| `CREW_NO_STREAM` | false | Disable streaming output |
| `CREW_MAX_SESSION_TOKENS` | 100000 | Token budget per session |
| `CREWSWARM_WORKTREE_ISOLATION` | true | Git worktree isolation for parallel agents |
| `TELEGRAM_BOT_TOKEN` | - | Telegram bridge bot token |

---

## 5. Cloud Deployment

### AWS / GCP / DigitalOcean

Any Ubuntu VM works:

```bash
ssh your-server
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

The install script handles Docker installation, image building, firewall setup, and service startup.

Access dashboard at `http://your-server-ip:4319`. For production, put nginx or Caddy in front with TLS:

```bash
# Example with Caddy (auto-TLS)
caddy reverse-proxy --from crewswarm.example.com --to localhost:4319
```

### Kubernetes (roadmap)

Helm charts and Terraform modules are planned but not yet available. Deploy via Docker on any VM today.

---

## 6. Health Checks

```bash
# CLI diagnostics (checks Node, git, API keys, gateway, CLI version)
crew doctor

# HTTP health check (Docker/production)
curl http://localhost:18889/health
```

---

## 7. Troubleshooting

**Services won't start:**
```bash
# Check port conflicts
lsof -i :4319 -i :5010 -i :18889 -i :3333

# Restart all services
npm run restart-all
```

**Dashboard can't connect to RT bus:**
- Verify RT bus is running on port 18889
- Check `RT_AUTH_TOKEN` matches between services
- Check browser console for WebSocket errors

**No API keys detected:**
- Add keys in Dashboard → Providers tab
- Or set environment variables (GROQ_API_KEY, etc.)
- Or use OAuth: `claude auth login` / `codex auth login`
- Run `crew doctor` to verify

**High memory usage:**
- Assign cheaper models to non-critical agents (crew-pm, crew-qa)
- Reduce `CREW_MAX_SESSION_TOKENS`
- Docker: set memory limits in docker-compose.yml

---

## npm Packages

| Package | Install | Description |
|---------|---------|-------------|
| crewswarm | `npm i -g crewswarm` | Full platform (dashboard, services, CLI) |
| crewswarm-cli | `npm i -g crewswarm-cli` | Standalone CLI only |
| crewswarm-openclaw-plugin | `npm i crewswarm-openclaw-plugin` | OpenClaw integration plugin |

---

## Links

- [Documentation](https://crewswarm.ai/docs.html)
- [Security Architecture](https://crewswarm.ai/security.html)
- [Model Recommendations](https://crewswarm.ai/models.html)
- [Deploy Page](https://crewswarm.ai/deploy.html)

---

**Last updated:** 2026-04-05
