# Docker Deployment

Run crewswarm on any Linux server with Docker.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

Or manually:

```bash
git clone https://github.com/crewswarm/crewswarm.git
cd crewswarm
docker compose up -d
```

## Pre-built images

```bash
docker pull crewswarm/crewswarm:latest
docker pull ghcr.io/crewswarm/crewswarm:latest
```

**Multi-arch:** AMD64 + ARM64 (Apple Silicon, Raspberry Pi, Graviton)

## Services

| Service | Port |
|---------|------|
| crewswarm-core | 4319 (dashboard + crew-lead + agents) |
| crewswarm-rt-bus | 18889 |
| crewswarm-mcp | 5020 (optional) |

## Configuration

API keys in `docker/.env`:

```bash
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Volumes: `~/.crewswarm` → config, logs, memory; `./projects` → workspace.

## Full guide

See [docker/README.md](../docker/README.md) for detailed setup, use cases, and environment variables.
