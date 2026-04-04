# Changelog

All notable changes to the crew-cli project.

## [0.3.5] - 2026-04-03

### Added

#### 7 Agentic Execution Features
- **Streaming tool execution**: tool calls and results stream incrementally via SSE — no more waiting for full response before display.
- **Smart request batching**: independent tool calls in the same turn are batched into a single network round-trip, reducing latency on multi-tool steps.
- **Context compaction**: conversation history is compressed when approaching the model's context window, preserving the most relevant turns via token-weighted summarization.
- **Abort support**: long-running autonomous loops can be cancelled mid-turn via `Ctrl+C` or the `/abort` command without orphaning background processes.
- **Budget enforcement**: `CREW_MAX_COST_USD` and `CREW_MAX_TURNS` gates halt autonomous loops before overrun.
- **History clearing**: `/clear` command resets conversation history in the REPL without restarting the session.
- **Scratchpad memory**: agents can write intermediate reasoning to a local scratchpad (`~/.crewswarm/scratchpad/`) that persists across turns but is excluded from the context window.

#### 3 Long-Run Stability Features
- **Max-output recovery**: when a tool result is truncated (> 100 KB), the executor retries with a summarization prompt rather than crashing the turn.
- **Post-sampling hooks** (`src/executor/post-sampling-hooks.ts`): user-defined callbacks that fire after each model sample — use for logging, guardrails, or custom routing without modifying the core executor.
- **Reactive context compaction**: compaction now triggers automatically when token usage crosses a configurable threshold (`CREW_COMPACT_THRESHOLD`, default 85% of context window), rather than only at turn boundaries.

#### 6 New Tools
- **LSP** (`src/tools/gemini/lsp.ts`): TypeScript/JavaScript language-server integration — `lsp_check` for type errors, `lsp_complete` for autocomplete suggestions at a given file position.
- **NotebookEdit** (`src/tools/gemini/notebook-edit.ts`): read, insert, replace, and delete cells in Jupyter `.ipynb` notebooks; preserves kernel metadata and cell outputs.
- **SpawnAgent** (`src/tools/gemini/spawn-agent.ts`): dispatch a sub-agent with a separate system prompt and tool set, collect its result, and inject it back into the parent conversation.
- **Worktree** (`src/tools/gemini/worktree.ts`): `enter_worktree` / `exit_worktree` / `merge_worktree` / `list_worktrees` — isolated git branches per agent, auto-cleanup if no changes, squash-merge back on success.
- **Sleep** (`src/tools/gemini/sleep.ts`): `sleep_ms` and `sleep_until` for timed waits inside autonomous loops (e.g., polling for a build to finish).
- **ToolSearch** (`src/tools/gemini/tool-search.ts`): `tool_search` lets agents dynamically discover available tools by keyword at runtime without loading all definitions upfront.

#### Other Additions
- Dashboard Testing tab integration: crew-cli test results (906 tests) stream to the Testing tab via SSE in real time.
- `crew doctor` now reports test suite health alongside API key and gateway checks.
- Schema validator utility (`src/utils/schemaValidator.ts`) for validating tool input against JSON Schema before dispatch.
- Confirmation bus (`src/confirmation-bus/`) for routing tool approval prompts to the dashboard UI rather than blocking the CLI.
- 906 passing tests across unit, integration, and tool-level suites (up from ~450 in 0.3.4). Includes dedicated test files for all 6 new tools.
- Published to npm as `crewswarm-cli@0.3.5`.

### Changed
- Multi-turn driver (`src/executor/multi-turn-drivers.ts`): refactored to support streaming tool execution and reactive compaction. Legacy blocking path still available under `CREW_LEGACY_EXECUTOR=1`.
- Stream helpers (`src/executor/stream-helpers.ts`): new shared `streamToolResult()` and `streamCompactionEvent()` helpers used across all executor paths.
- Gemini tool adapter (`src/tools/gemini/crew-adapter.ts`): updated to handle new tool schemas and post-sampling hook registration.
- Autonomous loop (`src/worker/autonomous-loop.ts`): integrates budget gates, abort signal handling, and reactive compaction.

### Fixed
- Dynamic Gemini declaration builder: `CREW_GEMINI_DYNAMIC_DECLARATIONS` default now correctly `true` (was `false` due to env-coercion bug).
- OAuth signing: all three Claude models (Haiku / Sonnet / Opus) and OpenAI GPT-5.x confirmed working via CCH token.
- `/model` and `/models` REPL command collision — consolidated into `/stack`; original routes kept as aliases with deprecation notice.
- Lowercase brand name: `crewswarm` normalized everywhere (was mixed `CrewSwarm` / `crewswarm` in banners, logs, and npm metadata).
- DISPATCH route no longer activated in standalone mode — eliminates spurious "no agent found" log lines.

---

## [0.3.4] - 2026-04-02

### Added
- Dashboard Models page OAuth section: token cache display, 5 new endpoints (`/oauth/token`, `/oauth/refresh`, `/oauth/status`, `/oauth/models`, `/oauth/revoke`), and `allModels` injection into the model picker.
- 56 new tests covering OAuth TTL, token refresh flows, and model enumeration across all three Claude model tiers.

### Fixed
- OAuth TTL: tokens now refresh proactively before expiry rather than waiting for a 401 response.
- All three Claude models (Haiku / Sonnet / Opus) and OpenAI GPT-5.x verified working via CCH signing.

---

## [0.3.3] - 2026-04-01

### Added
- 33 new unit tests and 10 new Playwright browser specs covering engine passthrough, session resume, and CLI dispatch flows.
- `CREWSWARM_TEST_MODE` guard: strict `"true"` equality check (not `"1"`) prevents test runs from writing to real config directories.
- 50 new integration tests covering OAuth TTL refresh, spending double-count regression, and async I/O blocking on Node 25.

### Fixed
- 12 source bugs identified and fixed during testing overhaul: spending double-count on multi-turn tasks, DLQ replay race condition, async I/O blocking on Node 25 (249 sync `fs` calls converted to async), and proxy routing edge cases.

---

## [0.3.2] - 2026-03-31

### Added
- Unified pipeline now default for standalone mode; `--legacy-router` flag for fallback.
- Self-consistency gate (`CREW_SELF_CONSISTENCY_GATE_ENABLED`) validates synthesized output against worker evidence before returning a result.
- Adaptive QA rounds: small edits skip full QA cycle when diff size is below `CREW_QA_SMALL_EDIT_THRESHOLD`.

### Changed
- crew-cli version bumped 0.3.1 → 0.3.2.
- All 6 CLI engine session-resume paths (Claude Code, Cursor, Codex, Gemini CLI, OpenCode, crew-cli) verified end-to-end via new integration tests.

---

## [0.1.0-alpha] - 2026-03-01

### 🎉 Phase 5 Complete - Advanced Multi-Agent Orchestration

This release marks the completion of Phase 5, transforming `crew-cli` from a simple gateway client into a sophisticated, speculative multi-agent orchestrator with deep developer experience features.

### ✅ Added

#### Intelligence & Speculative Execution
- **Speculative Explore (`crew explore`)**: Automated execution of a task across 3 parallel sandbox branches using different strategic prompts (Minimal, Clean, Pragmatic).
- **Tier 3 Worker Pool**: High-performance parallel execution of independent plan steps with bounded concurrency and automated conflict merging.
- **AgentKeeper Persistent Memory**: Cross-run memory store that allows agents to recall successful patterns and avoid repeating prior mistakes.
- **LSP Integration**: Built-in support for TypeScript type-checking (`crew lsp-check`) and autocomplete suggestions (`crew lsp-complete`).
- **Blast Radius Analysis**: Predictive impact analysis that scores the risk of changes based on the repository dependency graph.
- **Local RAG Search (`crew docs`)**: TF-IDF ranked search over local documentation and markdown files with automatic context injection.

#### Core CLI & DevEx
- **Natural Language Shell (`crew shell`)**: GitHub Copilot CLI-style translation of natural language into OS-specific shell commands with interactive execution.
- **Interactive PTY (`crew exec`)**: Full pseudo-terminal support for running interactive tools like `vim`, `htop`, or custom scripts directly via the agent.
- **Repository Mapping**: Visual dependency-aware codebase graph generation (`crew map --graph`).
- **Image Context**: Visual ingestion support—attach screenshots or images to tasks using the `--image` flag.
- **Speculative Implementation**: Enhanced sandbox branching (`crew branch`, `crew switch`, `crew merge`) for non-destructive experimentation.
- **Token Caching**: Automated local caching of model outputs to reduce costs and latency for repeated tasks.

#### Operational Hardening
- **GitHub Intelligence**: Natural language flows for issues and PRs, including a health check tool (`crew github doctor`) and safe preview (`--dry-run`).
- **Model Policies**: Centralized model tier configuration, fallback chains, and max-cost gates in `.crew/model-policy.json`.
- **REPL Hardening**: Full multi-agent conversation support in REPL with mode audit logging and autopilot cycling (Shift+Tab).
- **ASCII Banner**: High-impact launch branding for new CLI sessions.

#### Infrastructure
- **3-Tier LLM Architecture**: Optimized routing (Gemini 2.0 Flash) -> Planning (Claude 3.5 Sonnet) -> Execution (Worker Crew).
- **OAuth Token Recovery**: Automated discovery of existing session tokens from Claude Code, Cursor, and Gemini to eliminate redundant API costs.
- **Enhanced Test Suite**: Expanded to 91 comprehensive unit and integration tests covering all new intelligence and DevEx modules.

### 🔧 Fixed
- **REPL Interception**: Removed local hardcoded "direct response" logic to ensure all chat messages reach the actual specialist agents.
- **Context Bloat**: Implemented strict context budget guards with configurable trim/stop behaviors.
- **Sandbox Stability**: Improved deterministic merging and failure rollback for parallel worker outputs.

### 📊 Statistics
- **Tests Added:** 85+ (Total: 91)
- **Files Created:** 30+ new modules
- **Architecture:** Transitioned to full 3-Tier LLM execution model
- **Success Rate:** 100% test pass rate

---

## [0.1.0] - 2026-02-28

### 🎉 Initial Implementation - Production Ready
- **Agent Router** (`src/agent/router.js`)
- **Tool Manager** (`src/tools/manager.js`)
- **Base Documentation & Tests**

---

**Full Project Roadmap:** See [ROADMAP.md](ROADMAP.md)
