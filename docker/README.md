# crewswarm Docker Deployment

> **Production-ready containers** — Run crewswarm on any Linux server

## Quick Start

### One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/docker/install.sh | bash
```

### Manual Docker Compose

```bash
git clone https://github.com/crewswarm/crewswarm.git
cd crewswarm/docker
docker compose up -d
```

## Pre-Built Images

```bash
# Docker Hub
docker pull crewswarm/crewswarm:latest

# GitHub Container Registry (ghcr.io)
docker pull ghcr.io/crewswarm/crewswarm:latest
```

**Multi-arch support:** AMD64 + ARM64 (Apple Silicon, Raspberry Pi, AWS Graviton)

## What's Included

| Service | Port | What it does |
|---------|------|--------------|
| `crewswarm-core` | 4319 | Dashboard + crew-lead + agents |
| `crewswarm-rt-bus` | 18889 | Real-time message bus |
| `crewswarm-mcp` | 5020 | MCP server (optional) |

## Configuration

**API Keys:** Set in `docker/.env`

```bash
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

**Volumes:**

| Host Path | Container Path | What it stores |
|-----------|----------------|----------------|
| `~/.crewswarm` | `/root/.crewswarm` | Config, logs, memory |
| `./projects` | `/workspace` | Project files (persistent) |

## Use Cases

### 1. Dedicated Team Server

Run on a VPS for your team to share one crewswarm instance.

```bash
# DigitalOcean, AWS, GCP, Azure
ssh root@your-server.com
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/docker/install.sh | bash

# Access dashboard: http://your-server.com:4319
```

**Recommended specs:**
- 2+ CPU cores
- 4GB+ RAM
- 20GB+ disk

### 2. Edge/Home Server

Run on Raspberry Pi 4/5, NUC, or home server.

```bash
# Same install script works on ARM64
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/docker/install.sh | bash
```

### 3. CI/CD Integration

Use in GitHub Actions, GitLab CI, etc.

```yaml
# .github/workflows/build.yml
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      crewswarm:
        image: crewswarm/crewswarm:latest
        ports:
          - 5010:5010
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
    steps:
      - name: Run tests with crew-qa
        run: |
          curl -X POST http://localhost:5010/api/dispatch \
            -d '{"agent":"crew-qa","task":"Test the PR"}'
```

## Environment Variables

See [`../docs/ENVIRONMENT.md`](../docs/ENVIRONMENT.md) for full reference.

**Common ones:**

```bash
# Core
CREW_LEAD_PORT=5010
SWARM_DASH_PORT=4319

# Engines
CREWSWARM_OPENCODE_ENABLED=on
CREWSWARM_OPENCODE_MODEL=anthropic/claude-sonnet-4

# PM Loop
PM_MAX_CONCURRENT=2
PM_USE_QA=on
PM_USE_SECURITY=on
```

## Networking

**Internal (container-to-container):**
- Services communicate via Docker network
- No port mapping needed for internal traffic

**External (host-to-container):**
- Dashboard: `http://localhost:4319`
- crew-lead API: `http://localhost:5010`
- MCP server: `http://localhost:5020`

**Firewall:**
```bash
# Allow dashboard access
ufw allow 4319/tcp

# (Optional) Allow MCP for remote IDE connections
ufw allow 5020/tcp
```

## Persistence

**Config persists across restarts:**
- `~/.crewswarm/crewswarm.json` — Agent models
- `~/.crewswarm/config.json` — RT auth token
- `~/.crewswarm/agent-prompts.json` — System prompts

**Memory persists:**
- `~/.crewswarm/shared-memory/.crew/agent-memory/` — Cognitive facts
- `~/.crewswarm/shared-memory/.crew/agentkeeper.jsonl` — Task history

**Logs persist:**
- `~/.crewswarm/logs/` — All bridge logs
- `/tmp/crew-lead.log` — crew-lead log (ephemeral)

## Updating

```bash
cd crewswarm/docker
docker compose pull
docker compose up -d
```

## Monitoring

**Health checks:**
```bash
# All services healthy?
docker compose ps

# Check logs
docker compose logs -f crewswarm-core
docker compose logs -f crewswarm-rt-bus
```

**Dashboard health:**
```bash
curl http://localhost:4319/health
```

## Security

1. **Change default RT token:**
   ```bash
   # Edit ~/.crewswarm/config.json
   # Change rt.authToken to a random UUID
   ```

2. **Restrict dashboard access:**
   ```bash
   # Use nginx reverse proxy with auth
   # Or SSH tunnel: ssh -L 4319:localhost:4319 user@server
   ```

3. **Allowlist commands:**
   ```bash
   # Edit ~/.crewswarm/cmd-allowlist.json
   # Only allow safe commands
   ```

4. **Network isolation:**
   ```yaml
   # docker-compose.yml
   networks:
     crewswarm:
       internal: true  # No external access
   ```

## Troubleshooting

**Container won't start:**
```bash
docker compose logs crewswarm-core
# Check for missing API keys or port conflicts
```

**Dashboard not accessible:**
```bash
# Check if port is bound
netstat -tulpn | grep 4319

# Check firewall
ufw status
```

**Out of memory:**
```bash
# Increase container memory limit
docker compose up -d --scale crewswarm-core=1 --memory=4g
```

**Logs filling disk:**
```bash
# Clean old logs
docker system prune -a --volumes
```

## Production Checklist

- [ ] Set strong RT auth token
- [ ] Configure firewall (only 4319 exposed)
- [ ] Set up HTTPS reverse proxy (nginx/Caddy)
- [ ] Configure log rotation
- [ ] Set up backup for `~/.crewswarm/`
- [ ] Monitor disk usage
- [ ] Test disaster recovery

## Advanced: Multi-Node Setup

For high availability, run agents on separate nodes:

```bash
# Node 1: crew-lead + dashboard
docker run -d crewswarm/crewswarm:latest crew-lead

# Node 2-5: agent bridges
docker run -d crewswarm/crewswarm:latest gateway crew-coder
docker run -d crewswarm/crewswarm:latest gateway crew-qa
```

Configure RT bus to bind to `0.0.0.0` instead of `127.0.0.1`.

## Documentation

See [`../docs/docker.md`](../docs/docker.md) for complete Docker guide.

## License

MIT
