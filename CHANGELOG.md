# Changelog

All notable changes to CrewSwarm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0-beta] - 2026-03-04

### 🎉 Public Beta Release

First public release of CrewSwarm — PM-led multi-agent orchestration for software development.

### Added

#### Core Features
- **20 specialist agents** — crew-coder, crew-pm, crew-qa, crew-fixer, crew-security, crew-github, crew-copywriter, crew-frontend, crew-main, and more
- **5 execution engines** — OpenCode, Cursor CLI, Claude Code, Codex CLI, and Gemini CLI
- **PM Loop autonomous mode** — reads `ROADMAP.md`, dispatches items, retries failures, self-extends
- **Real file writes** — `@@WRITE_FILE`, `@@READ_FILE`, `@@MKDIR`, `@@RUN_CMD` tools with actual disk I/O
- **Shared memory system** — `brain.md`, `session-log.md`, persistent context across all agents
- **Command approval gate** — allowlist system for `@@RUN_CMD` with dashboard approval flow
- **Token/cost tracking** — per-agent spending dashboard with 14 LLM provider support

#### Skills System
- **51 pre-built skills** — 14 API integrations + 37 knowledge playbooks
- API skills: ElevenLabs TTS, Fly.io deploy, Twitter/X post, Polymarket trade, Greptile code search, Grok X-search, Grok Vision
- Knowledge skills: code-review, api-design, threat-model, roadmap-planning, positioning-icp, ai-seo, and 31 more

#### Multi-Platform
- **Dashboard** — Web UI on port 4319 (Chat, Agents, Build, Services, Settings, Providers tabs)
- **Telegram bridge** — Full bidirectional integration with topic routing
- **WhatsApp bridge** — Personal bot via Baileys (scan QR once)
- **crew-cli** — Command-line interface for all operations
- **MCP server** — Port 5020 exposes agents to Cursor, Claude Code, OpenCode, Codex

#### Infrastructure
- **CI/CD pipeline** — GitHub Actions smoke tests on every PR
- **Modular architecture** — God-file split complete (Phase 1)
- **Runaway protection** — Bridge cap, queue limits, jittered retries
- **Correlation IDs** — End-to-end request tracing
- **Structured logging** — JSON + human-readable formats (`LOG_FORMAT=json`)
- **Health checks** — `openswitchctl doctor` and `npm run health` diagnostics

#### Planning & Orchestration
- **Domain-aware planning** — Routes roadmap items to specialized PM agents (crew-pm-cli, crew-pm-frontend, crew-pm-core)
- **Wave dispatcher** — Parallel task execution with dependency management
- **Pipeline DSL** — Chain sequential tasks with `@@PIPELINE`
- **crew-judge** — Autonomous decision maker for PM loop (CONTINUE/SHIP/RESET)
- **PDD + TECH-SPEC + ROADMAP** — Three-document planning per project

#### Multimodal Support
- **Image recognition** — Groq or Gemini 2.0 Flash
- **Voice transcription** — Audio → text for dashboard, Telegram, WhatsApp
- Native integration in all platforms (dashboard 📷🎤 buttons, Telegram/WhatsApp media handlers)

### Changed
- **Engine routing** — Default changed to direct LLM calls (faster, cheaper)
- **Session management** — Per-project isolation with `~/.crewswarm/sessions/`
- **Memory layer** — Unified MemoryBroker blends AgentMemory + AgentKeeper + Collections

### Fixed
- Dashboard restart race condition (now uses dedicated script, not API)
- Telegram topic routing personality bleed
- Engine timeout watchdogs (activity-based, not wall-clock)
- PM loop self-extend infinite loops
- Cross-platform message history persistence

### Documentation
- `AGENTS.md` — Comprehensive AI setup guide (15,000+ words)
- `docs/ARCHITECTURE.md` — Canonical dispatch/result schemas
- `docs/TROUBLESHOOTING.md` — Top 5 issues quick-reference
- `docs/FRESH-MACHINE-VERIFY.md` — Clone → install → first build walkthrough
- 40+ specialized guides in `docs/`

### Infrastructure
- **Tests:** 433 passing (unit + integration + E2E)
- **CI:** GitHub Actions smoke tests on every PR
- **Fresh-machine automation:** `scripts/fresh-machine-smoke.sh`
- **Screenshot automation:** `scripts/capture-dashboard-hero.mjs`

---

## [Unreleased]

### Planned for v1.0
- Background Agent System (AutoFix) — autonomous bug fixing
- Skill marketplace — community skill registry
- Enhanced observability — telemetry dashboard
- Video demos — YouTube walkthroughs

---

## Version History

- **0.8.0-beta** (2026-03-04) — Public beta release
- **0.5.0** (2026-03-01) — Internal pre-release
- **0.1.0-alpha** (2026-01-15) — Initial development version

---

For full details, see [ROADMAP.md](ROADMAP.md) and [docs/](docs/)
