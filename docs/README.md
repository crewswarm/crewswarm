# crewswarm Documentation

Documentation index for the crewswarm multi-agent orchestration stack.

## Canonical docs (source of truth)

Start here. These are the maintained, authoritative guides:

| Doc | Description |
|-----|-------------|
| [docs/CANONICAL/README.md](CANONICAL/README.md) | Canonical docs map and navigation |
| [docs/CANONICAL/ROUTING.md](CANONICAL/ROUTING.md) | Shared chat, mentions, dispatch, thread continuity |
| [docs/CANONICAL/RUNTIME.md](CANONICAL/RUNTIME.md) | Engines, agent execution paths, runtime identity |
| [docs/CANONICAL/CURSOR-CLI.md](CANONICAL/CURSOR-CLI.md) | Cursor `agent` CLI, Keychain -50, `CURSOR_API_KEY` |
| [docs/CANONICAL/MEMORY.md](CANONICAL/MEMORY.md) | Shared memory, project messages, RAG role |
| [docs/CANONICAL/TESTING.md](CANONICAL/TESTING.md) | Smoke tests, regression coverage, verification rules |
| [docs/CANONICAL/INSTALL.md](CANONICAL/INSTALL.md) | Setup and installation |
| [docs/CANONICAL/DEMO-SCRIPT.md](CANONICAL/DEMO-SCRIPT.md) | 90-second demo script |

## Core guides

| Doc | Description |
|-----|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System diagram, port map, request flow |
| [ORCHESTRATOR-GUIDE.md](ORCHESTRATOR-GUIDE.md) | How dispatch and pipelines work |
| [SETUP-NEW-AGENTS.md](SETUP-NEW-AGENTS.md) | Adding custom agents |
| [MODEL-RECOMMENDATIONS.md](MODEL-RECOMMENDATIONS.md) | Model selection per agent |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and fixes |
| [UNIFIED-API.md](UNIFIED-API.md) | REST API overview |

## Deployment & ops

| Doc | Description |
|-----|-------------|
| [docker.md](docker.md) | Docker install and deployment |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Environment variables reference |

## Surfaces & ports

| Surface | Port | Doc |
|---------|------|-----|
| Dashboard | 4319 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Vibe / Studio | 3333 | [CANONICAL/SURFACES.md](CANONICAL/SURFACES.md) |
| Studio watch | 3334 | `npm run studio:watch` — live reload WebSocket |

## Legacy & specialized

Older or specialized docs live in `docs/` — see file list. Prefer canonical docs when they overlap.

## Archived root guides (bookmarks)

If an old link pointed at a root-level `*-COMPLETE.md` file, see **[docs/archive/legacy-root-guides/README.md](archive/legacy-root-guides/README.md)** for the replacement map.

## Maintainer-only

- **[docs/internal/MAINTAINER-CHECKLIST.md](internal/MAINTAINER-CHECKLIST.md)** — pre-release / repo hygiene checklist (not required reading for end users).
