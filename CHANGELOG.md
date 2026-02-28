# Changelog

All notable changes to CrewSwarm are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **PRD interview flow** — Stinki now asks 5 structured questions (persona, problem, success metric, constraints, non-goals) before firing the planning pipeline for vague "build me X" requests
- **PDD.md auto-generation** — every new project writes a `PDD.md` product design doc alongside `ROADMAP.md` at confirm time
- **Skills type separation** — dashboard Skills tab now shows two sections: **Knowledge** (SKILL.md folder-based playbooks) and **API Integrations** (JSON endpoint skills)
- **Knowledge skills visible in dashboard** — `GET /api/skills` now returns all 44 skills with `type: "api" | "knowledge"`; previously SKILL.md skills were invisible in the UI
- **Per-agent skill assignments** — 15 agent roles each have a dedicated skill (code-review, api-design, threat-model, adr-generator, etc.) referenced in their system prompts
- **GTM skills suite** — imported 15 skills from chadboyda/agent-gtm-skills: ai-seo, content-to-pipeline, positioning-icp, gtm-metrics, ai-pricing, solo-founder-gtm, lead-enrichment, ai-cold-outreach, social-selling, multi-platform-launch, ai-ugc-ads, paid-creative-ai, expansion-retention, partner-affiliate, gtm-engineering
- **PM skills wired into planning loop** — wave 1 uses `@@SKILL problem-statement`, wave 3 uses `@@SKILL roadmap-planning`
- **SECURITY.md** — responsible disclosure policy
- **PULL_REQUEST_TEMPLATE.md** — standardised PR description format
- **Architecture diagram** — Mermaid system diagram in docs

### Fixed
- **WhatsApp PID test** — gracefully skips stale PID files instead of failing with "Invalid PID"
- **`prd-development` skill removed** — was redundant after PRD interview flow added to Stinki
- **Knowledge skill DELETE** — `DELETE /api/skills/:name` now removes folder-based skills as well as `.json` files

---

## [0.9.0] — 2026-02-27

### Added
- **Activity-based engine watchdog** — Cursor CLI / Claude Code / OpenCode tasks killed only after idle silence (configurable `CREWSWARM_ENGINE_IDLE_TIMEOUT_MS`), not a fixed wall-clock timer
- **PM loop adaptive timeout** — `PM_AGENT_IDLE_TIMEOUT_MS` watchdog replaces fixed timeout; resets on any stdout/stderr activity
- **Telegram singleton guard** — PID file prevents multiple `telegram-bridge.mjs` instances; duplicate replies eliminated
- **WhatsApp singleton guard** — same pattern applied to `whatsapp-bridge.mjs`
- **Passthrough session persistence** — Codex and Gemini CLI session IDs stored in `~/.crewswarm/passthrough-sessions.json`; sessions resume across restarts
- **Gemini `--approval-mode yolo`** — auto-approves all file writes; no more blocked passthrough sessions
- **Codex `--full-auto`** — workspace-write sandbox with auto-approval; write permission no longer required manually
- **Kill CLI button** — `AbortController`-based stop for active engine passthrough streams; "⏹ Kill CLI" button appears during streaming
- **Docker Sandbox removed from engine dropdown** — was inappropriate for general use
- **Unified engine labels** — consistent plain-text labels across all engines (no emoji inconsistency)
- **Environment Variables tab expanded** — 39 total variables (was 27); all new timeout/watchdog/PM env vars surfaced with defaults pre-populated
- **Provider URL fixes** — Cerebras, NVIDIA NIM, Google providers now have correct `BUILTIN_URLS`; "Failed to parse URL from /models" resolved
- **12 new env vars surfaced**: `CREWSWARM_ENGINE_IDLE_TIMEOUT_MS`, `CREWSWARM_ENGINE_MAX_TOTAL_MS`, `PM_AGENT_IDLE_TIMEOUT_MS`, `CREWSWARM_GEMINI_CLI_ENABLED`, `CREWSWARM_GEMINI_CLI_MODEL`, `CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS`, `PM_USE_SPECIALISTS`, `PM_SELF_EXTEND`, `PM_EXTEND_EVERY`, `PM_CODER_AGENT`, `PM_MAX_CONCURRENT`, `PHASED_TASK_TIMEOUT_MS`
- **Background consciousness loop tests** — 36 unit tests covering all provider/interval/stall/alert logic
- **Ouroboros loop tests** — 45 unit tests covering full STEP/DONE parse and loop execution
- **PM synthesis tests** — 49 unit tests covering verdict detection, semaphore, phase routing, FINAL_REPORT
- **Telegram E2E tests** — 10 tests covering bot API, message delivery, bridge lifecycle
- **WhatsApp E2E tests** — 13 tests covering bridge state, auth persistence, singleton guard
- **PM loop live E2E tests** — 12 tests against a running PM loop
- **PM skills**: `problem-statement`, `roadmap-planning`, `prioritization-advisor`, `epic-breakdown-advisor`, `product-strategy-session`, `user-story`, `problem-framing-canvas`, `opportunity-solution-tree`, `epic-hypothesis`, `discovery-process` — installed from deanpeters/Product-Manager-Skills
- **Import skills via URL** — dashboard Skills tab can import SKILL.md skills from any raw GitHub URL

### Fixed
- **RT bus flood** — `opencrew-rt-daemon.mjs` now evicts stale connections on re-hello; WebSocket slot count dropped from 180+ to ~20 unique agents
- **Runaway duplicate processes** — `restart-all-from-repo.sh` uses broader `pkill` patterns; `crew-scribe` now included; `mcp-server` has `lsof` guard
- **Duplicate dashboard replies from passthrough** — `_passthroughSummary` flag prevents the final `agent_reply` SSE from rendering twice
- **Duplicate Telegram replies** — singleton guard prevents multiple bridge instances
- **Env var inputs showing empty** — inputs now pre-populate with code defaults; "default" badge shown
- **`CREWSWARM_DISPATCH_TIMEOUT_MS` naming mismatch** — standardized across API and UI

### Changed
- **CSS centralized** — all input field styles moved to `frontend/src/styles.css`; inline styles replaced with utility classes

---

## [0.8.0] — 2026-02-20

### Added
- **Gemini CLI engine** — route any agent through `gemini` CLI; stream-json event parsing; `--output-format stream-json` support
- **Codex CLI engine** — `codex exec --sandbox workspace-write --json` support; session continuity via `exec resume --last`
- **Engine Loop (Ouroboros)** — LLM decomposes task into STEP instructions; each STEP executed by active engine; loops until DONE or max rounds
- **Background consciousness** — periodic idle reflection cycle for crew-main; writes to `~/.crewswarm/process-status.md`; Groq fast-path for cheap cycles
- **Benchmark runner** — `GET /api/zeroeval/benchmarks` + `GET /api/zeroeval/benchmarks/{id}`; dashboard Benchmarks tab
- **PM final synthesis** — after roadmap completes, crew-main runs audit + assembly phases; writes `FINAL_REPORT.md`
- **Phase-gated PM loop** — `PM_MAX_CONCURRENT` parallel task limit; `PHASED_TASK_TIMEOUT_MS` per-agent timeout
- **Telemetry schema** — JSON Schema validation for all telemetry events; `validateTelemetryEvent` helper
- **`@@APPEND_FILE` tool** — non-destructive file append for agents
- **Spending tab** — daily token usage + cost per agent

### Fixed
- **Gemini CLI stream-json event schema** — corrected event parsing in both runner and RT envelope
- **RT envelope handling** — extracted into `lib/engines/rt-envelope.mjs`
- **Skills save 500 bug** — fixed in dashboard API
- **Docker build context + healthcheck** — `GET /health` endpoint added

### Changed
- **God-file split** — `crew-lead.mjs` and `gateway-bridge.mjs` refactored into 9+ focused modules under `lib/`
- **Frontend split** — `frontend/src/app.js` extracted into 11 focused tab modules

---

## [0.7.0] — 2026-02-10

### Added
- **Wave-based parallel pipeline** — `@@PIPELINE` DSL; same-wave tasks run in parallel, higher waves wait
- **Quality gate** — after each wave, crew-qa audits output; auto-inserts crew-fixer if issues found
- **Task lease system** — deduplication + heartbeat to prevent double-dispatch
- **Command approval gate** — `@@RUN_CMD` from untrusted agents shows dashboard toast (Allow/Deny, 60s countdown)
- **Pre-approved command allowlist** — patterns like `npm *` skip the gate; dangerous commands always blocked
- **`@@STOP` / `@@KILL` signals** — cancel all pipelines; KILL also SIGTERMs all bridges
- **Autonomous mode** — PM loop self-extends when roadmap empties; configurable `PM_SELF_EXTEND` + `PM_EXTEND_EVERY`
- **Scheduled pipelines** — cron-runnable JSON workflow files in `~/.crewswarm/pipelines/`
- **WhatsApp bridge** — personal bot via Baileys; QR-scan once; `WA_ALLOWED_NUMBERS` gating
- **MCP server** — port 5020; exposes 13 tools to Cursor, Claude Code, OpenCode, Codex CLI
- **OpenAI-compatible API** — same port 5020; use with Open WebUI or any custom base URL
- **SwiftBar menu bar plugin** — macOS menu bar with agent status, quick dispatch, service controls
- **PM keyword routing** — `PM_USE_SPECIALISTS` routes frontend/backend/git tasks to the right specialist

### Fixed
- **CI glob expansion** — removed quotes from `*.test.mjs` patterns in GitHub Actions
- **Multiple legacy config path fixes** — `~/.openclaw/` → `~/.crewswarm/` migration completed

---

## [0.6.0] — 2026-01-28

### Added
- **Initial test suite** — 203 tests across unit, integration, and E2E
- **GitHub Actions CI** — `smoke.yml` runs on every PR
- **Docker support** — `Dockerfile` + `docker.md`; Docker sandbox engine adapter
- **`@@DEFINE_SKILL` / `@@DEFINE_WORKFLOW`** — agents can create skills and workflows inline
- **Skill import via URL** — paste any raw GitHub URL to install a skill
- **ZeroEval benchmark integration** — `GET /api/zeroeval/benchmarks`

### Changed
- **Rebranded from OpenClaw → CrewSwarm** — all config paths, env vars, and UI references updated
- **Config moved** — `~/.openclaw/` → `~/.crewswarm/`

---

## [0.5.0] — 2026-01-15

### Added
- **PM loop** — reads `ROADMAP.md`, dispatches items one at a time, retries failures, reports done
- **`@@PROJECT` command** — AI-generated roadmap from a one-line description
- **Project registration** — dashboard Projects tab; `@@REGISTER_PROJECT` from agents
- **Five execution engines** — OpenCode, Cursor CLI, Claude Code, Codex CLI, Gemini CLI
- **Telegram bridge** — bidirectional; isolated sessions per chat; `/projects` + `/status` commands
- **Shared memory system** — `brain.md`, `session-log.md`, `current-state.md` injected into every agent
- **crew-scribe** — background memory maintenance; LLM summaries written to `session-log.md`

---

## [0.1.0] — 2025-12-01

### Added
- Initial release — multi-agent orchestration via RT WebSocket bus
- `crew-lead.mjs` (commander), `gateway-bridge.mjs` (per-agent daemon)
- Dashboard (port 4319), crew-lead API (port 5010), RT bus (port 18889)
- `@@DISPATCH`, `@@WRITE_FILE`, `@@READ_FILE`, `@@RUN_CMD`, `@@BRAIN` tools
- Agent roster: crew-coder, crew-qa, crew-fixer, crew-pm, crew-copywriter, crew-main, crew-github, crew-security
- Any-model, any-provider — Groq, Anthropic, OpenAI, Mistral, DeepSeek, Perplexity
- MIT License
