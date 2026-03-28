# Changelog

All notable changes to crewswarm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3-beta] - 2026-03-28

### Added
- Vibe: diff preview for ALL 6 engine writes (not just @@WRITE_FILE) — Monaco side-by-side diff
- Vibe: multi-file diff queue with Accept / Dismiss / Accept All buttons
- Vibe: reject reverts CLI-written files to previous content on disk
- crew-cli REPL: deferred sandbox apply in manual/assist mode — shows diff before writing
- crew-cli: `crew plan` generates 7 planning artifacts with dual-model validation
- crew-cli: `crew test-first` TDD pipeline (tests → implement → validate)
- crew-cli: `crew validate` blind code review with scores and verdicts
- crew-cli: `crew auto` autonomous mode
- crew-cli: `crew doctor` health check (6/7 checks)
- Website: CLI page rewritten with 7 commands and 3-tier pipeline diagram
- Website: 4-step workflow demo (build → polish → errors → security)
- Website: architecture section updated (22 agents, 6 engines, RT bus channels)
- Launch plan with HN post, Twitter thread, Reddit posts, FAQ

### Fixed
- crew-cli: file writes blocked by path traversal guard on absolute paths
- crew-cli: `[object Object]` response serialization
- crew-cli: REPL hang from home directory (repo indexer now skips ~ and /)
- crew-cli: binary was pointing to stale Desktop copy (relinked)
- Claude Code: stale session resume causing "no text output" — dispatch tasks start fresh
- Website: performance 70→78 (mascot resize, favicon webp, fetchpriority, cache TTL)
- Website: mobile overflow fixes, architecture section accuracy
- Website: case studies updated with real benchmark data (17s weather dashboard)

## [0.8.2-beta] - 2026-03-27

### Added
- Native session resume for all 6 CLI engines (Claude `--resume`, Cursor `--resume`, Gemini `--resume`, Codex resume, OpenCode `--continue`)
- Clear session button in Vibe + API endpoint
- 21 new E2E tests (multi-engine dispatch, chat passthrough, session resume, cron workflow, PM loop multi-engine)
- 12 new LLM providers: Together, HuggingFace, Venice, Moonshot, MiniMax, Volcengine, Qianfan, Fireworks, OpenRouter, vLLM, SGLang (total: 24)
- OpenClaw plugin published to npm (`crewswarm-openclaw-plugin`) — 22 agents accessible from OpenClaw's 336K user base
- OpenClaw API key migration in install.sh — auto-detects `~/.openclaw/openclaw.json`
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- docs/TESTING.md — all ~1,100 test cases documented across 8 suites
- docs/ADDING-AGENTS.md — how to add new agents
- docs/CUSTOM-SKILLS.md — API and knowledge skill creation guide
- docs/OPENCLAW-PLUGIN.md — plugin install, config, publishing
- Website: API reference (Redoc), blog (3 posts), changelog page, OpenClaw comparison
- Website: 22 provider cards, npm copy button, "Works with" logo strip
- npm auto-publish CI workflow on version tags
- Dashboard: 9 new provider cards in models tab and setup wizard

### Fixed
- Removed all hardcoded `/Users/jeffhobbs` paths (39 files cleaned)
- Scrubbed Telegram chat IDs from git history (`git filter-repo`)
- `/api/health` returns liveness without auth (was 401, broke monitoring and CI)
- Dashboard service status flapping: bumped timeouts (portListening 350ms→2s, httpOk 900ms→3s)
- Dashboard restart script: targeted kill prevents cascading service deaths
- WhatsApp bridge: `@lid` JID allowlist matching (self-chat messages used wrong format)
- WhatsApp bridge: stop AI replying to other people's @lid chats
- Stale session auto-cleanup on resume failure
- `--bare` flag removed from Claude Code runner (was causing "Not logged in")
- `@whiskeysockets/baileys` moved to optionalDependencies (npm install works without git)
- Dashboard engine labels fixed (direct-llm, claude-code, gemini-cli, crew-cli)
- Gemini CLI updated 0.34.0 → 0.35.2 (fixed sysctl crash)
- crew-cli projectDir string guard (fixed "path argument" error)
- Removed hardcoded Cursor engine from crew-orchestrator dispatch
- Claude Code stale session resume causing "no text output" — dispatch tasks now start fresh
- Vibe IDE: added `--output-format stream-json --verbose` for Claude Code + stream parser
- Reverted `--bare` flag (breaks OAuth auth)

### crew-cli (0.2.4)
- Fixed file writes: path traversal guard blocked all absolute paths — now writes directly for absolute, sandbox for relative
- Fixed `[object Object]` response serialization — tool results now extract `.output`/`.error`
- Fixed REPL hang from home directory — repo indexer skips `~` and `/`
- Added all providers from `crewswarm.json` to status dashboard (was hardcoded to 6)
- REPL mode picker: error logging instead of silent swallow
- Relinked `crew` binary to repo (was pointing to stale Desktop copy)

### Website
- Hero rewrite, competitor table, rate limits section, per-agent model pricing
- Quickstart video, pricing section, proof points, GitHub badge
- Mobile-ready: zero horizontal overflow, all grids collapse on mobile
- Performance: mascot 69KB→48KB, favicon PNG→WebP 46KB→11KB, fetchpriority on LCP
- Removed demo script section, fake testimonials replaced with AI engine quotes
- CLI page rewritten: 7 commands, 3-tier pipeline diagram, correct npm package name
- Case studies updated with real benchmark data (17s weather dashboard, VS Code 3-model benchmark)
- SEO optimization across all pages

### Tests
- 957 total tests, 0 failures (up from 731)

## [0.8.1-beta] - 2026-03-25

### Security
- Scrubbed personal phone number from all source files, docs, and examples
- Removed accidental LLM artifact file containing personal paths
- Fixed GitHub URLs to use org account instead of personal

### Fixed
- PM loop dry-run: self-extend generates placeholder items instead of calling LLM
- PM loop process now exits cleanly after main() completes
- PM loop E2E test: fixed stop-file path mismatch (was using wrong directory)
- PM loop E2E test: wrapped describe blocks in `concurrency: 1` to prevent races
- Pipeline-waves E2E: switched from crew-main (hangs) to crew-coder, added warm-up preflight
- Dashboard-api integration tests: added `concurrency: 1` to prevent timeout cascade
- WhatsApp bridge test: graceful handling of stale PID files

## [0.8.0-beta] - 2026-03-04

### Internal Beta

Initial beta milestone — PM-led multi-agent orchestration for software development.

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

### Added (March 2026)
- **Pre-launch security audit** — Removed exposed API keys, added security checks
- **Documentation cleanup** — Moved 280+ session summaries to `docs/dev-notes/`
- **KNOWN-ISSUES.md** — Comprehensive known issues documentation
- **Project message persistence** — All chat messages auto-saved to `~/.crewswarm/project-messages/`
- **Unified chat history** — CLI, dashboard, and bridge messages all saved in one place
- **Auto-RAG indexing** — Project messages automatically indexed for semantic search
- **Cache headers** — Prevents stale data when switching tabs
- **Message export** — Export project chat as markdown, JSON, CSV, or text

### Changed
- **Session summaries** — Organized in `docs/dev-notes/` instead of root
- **API key management** — Example files with placeholders, real files in `.gitignore`

### Fixed
- Git security — Removed `crew-cli/setup-keys.sh` from tracking
- Documentation bloat — Reduced root markdown files by 43%

### Planned for v1.0
- Skill marketplace — community skill registry
- Enhanced observability — telemetry dashboard
- Video demos — YouTube walkthroughs

### Shipped since beta (not yet in versioned release)
- **Browser automation** — CDP client with headless Chrome, screenshots, console error capture (`crew-cli/src/browser/index.ts`)
- **Background Agent System (AutoFix)** — persisted job queue, unattended worker loop, safety gates (`crew-cli/src/autofix/`)

---

## Version History

- **0.8.0-beta** (2026-03-04) — Public beta release
- **0.5.0** (2026-03-01) — Internal pre-release
- **0.1.0-alpha** (2026-01-15) — Initial development version

---

For full details, see [ROADMAP.md](ROADMAP.md) and [docs/](docs/)
