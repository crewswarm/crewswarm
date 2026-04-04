# crew-cli

Command-line interface for CrewSwarm agent orchestration with local safety rails (sandbox diffs, session state, routing/cost logs), team sync, CI/browser helpers, and voice mode.

---
**[OVERVIEW.md](docs/OVERVIEW.md)** - 🚀 1-minute summary of what this is and how it works.
**[INSTRUCTION-STACK.md](docs/INSTRUCTION-STACK.md)** - canonical instruction precedence and composition
**[PERMISSIONS-MODEL.md](docs/PERMISSIONS-MODEL.md)** - canonical read/write/shell/approval behavior by mode
**[MODES-AND-FLAGS.md](docs/MODES-AND-FLAGS.md)** - which knobs matter, recommended defaults, and what to ignore at first
---

## Requirements

- Node.js 20+
- Git
- Optional for full integration: running CrewSwarm gateway (`http://127.0.0.1:5010`)

## Install

```bash
npm install
npm run build
```

Run the CLI:

```bash
node bin/crew.js --help
```

## Recommended Defaults

For most users:

- start in `assist`
- keep engine on `auto`
- leave model unset unless you need a specific one
- use `--preset balanced` first

Examples:

```bash
crew repl --mode assist
crew chat "fix auth tests" --preset balanced
crew dispatch crew-coder "harden auth middleware" --preset quality
```

## Core Commands

```bash
crew chat "refactor auth middleware"
crew chat "build auth API with tests" --modefast6
crew dispatch crew-coder "fix failing tests"
crew dispatch crew-coder "harden auth middleware" --preset quality
crew run -t "build auth API with tests"     # unified pipeline (resumable)
crew run --resume pipeline-<trace-id>       # resume/replay from checkpoint trace
crew run --resume pipeline-<trace-id> --from-phase execute
crew explore "refactor database layer" # parallel speculative execution
crew plan "add OAuth login" --parallel
crew preview
crew apply --check "npm test"
crew rollback
```

## Intelligence Commands

```bash
crew map --graph                     # visual dependency graph
crew shell "list large files"        # NL to shell command translation
crew docs "how does auth work"       # RAG search over docs/markdown
crew blast-radius                    # impact analysis of current changes
crew capabilities                    # runtime capability handshake
crew memory "auth login"             # recall prior task memory
crew lsp check src/cli/index.ts      # TypeScript diagnostics
crew lsp complete src/cli/index.ts 10 5
crew repl                            # interactive multi-agent REPL
crew tui                             # terminal UI adapter (same runtime as REPL)
crew github "list open issues"       # NL GitHub flows
crew github doctor                   # GitHub CLI health check
```

## Advanced Commands

```bash
crew sync --status
crew privacy --show
crew serve --port 4317               # unified /v1 API + /mcp endpoint
crew exec "vim src/server.ts"        # interactive terminal (PTY)
crew listen --duration-sec 6
crew browser-debug --url http://127.0.0.1:4319
crew ci-fix --check "npm test"
crew doctor
```

### Pipeline Runtime Flags

- `CREW_USE_UNIFIED_ROUTER=false` - force-disable UnifiedPipeline routing path
- `CREW_LEGACY_ROUTER=true` - use legacy router/legacy standalone execution path
- `CREW_DUAL_L2_ENABLED=true` - enable Dual-L2 planning/decomposition
- `CREW_QA_LOOP_ENABLED=true` - run QA -> fixer -> final QA gate before completion
- `CREW_QA_MAX_ROUNDS=2` - max fixer rounds in QA loop
- `CREW_CONTEXT_BUDGET_CHARS=7000` - per-worker retrieved artifact context budget
- `CREW_CONTEXT_MAX_CHUNKS=8` - max retrieved artifact chunks per worker
- `CREW_CONTEXT_PACK_TTL_HOURS=24` - TTL for persisted context-pack cache in `.crew/context-packs`
- `CREW_TOOL_MODE=auto|native|markers` - tool execution mode (default `auto`)
- `CREW_GEMINI_DYNAMIC_DECLARATIONS=true|false` - use dynamic Gemini declaration builder (default `true`)
- `CREW_ENABLE_ADVANCED_ADAPTER_TOOLS=true|false` - enable safe advanced adapter tools in default pipeline (default `true`)
- `CREW_NO_ROUTER=true|false` - skip router classification and force execute-parallel flow

CLI preset flags (chat/auto/dispatch):
- `--preset fast6|turbo6|balanced|quality`
- `--modefast6` shortcut for `fast6`
- `--new-task` (chat only) ignores pending clarification resume and starts fresh

Preset summary:
- `fast6`: 6 parallel workers, QA 2 rounds, no-router, speed-focused
- `turbo6`: 6 parallel workers, QA off, no-router, max throughput
- `balanced`: 4 workers, QA 1 round, no-router, mixed speed/quality
- `quality`: 3 workers, QA 2 rounds + stricter gates, no-router

## Diagnostics & Health

```bash
crew doctor              # checks Node.js, Git, API keys, gateway, MCP, updates (~3s)
crew doctor --gateway http://custom:5010
```

`crew doctor` validates your environment and suggests fixes:
- **API key detection** — shows which of 10 providers are configured
- **Cheapest-first hints** — when no keys found, recommends Gemini (free) and Groq (free)
- **Gateway health** — verifies crew-lead is reachable
- **MCP server health** — checks configured MCP servers
- **Update check** — shows if a newer version is available on npm

## Key Engine Features

| Feature | Status |
|---|---|
| **Streaming output** | ✅ All providers — Gemini, OpenAI, Anthropic, Grok, DeepSeek, Groq, OpenRouter |
| **Session continuity** | ✅ SessionManager persists history across REPL sessions |
| **Auto-approve mode** | ✅ `--always-approve` flag for unattended execution |
| **Turn compression** | ✅ Topic-Action-Summary keeps prompts lean on long sessions |
| **JIT context** | ✅ Files discovered by tools are indexed for subsequent turns |
| **Repo-map RAG** | ✅ TF-IDF semantic search injected before execution |
| **Auto-retry** | ✅ Failed tool calls retry up to 3 times with auto-correction |
| **Infinite loop detection** | ✅ Repeating-action detector stops stuck agents |
| **Multimodal vision** | ✅ `--image` flag for Gemini, Claude, GPT-4o, Grok Vision |
| **Cost tracking** | ✅ Per-session token costs for all providers |

Adaptive QA + reliability:
- `CREW_QA_SMALL_EDIT_THRESHOLD=1` and `CREW_QA_SMALL_EDIT_ROUNDS=1` reduce QA rounds for tiny edits
- `CREW_DECOMPOSE_MAX_ATTEMPTS=2` retries lightweight decomposition on failure
- `CREW_SELF_CONSISTENCY_GATE_ENABLED=true` validates synthesized final output against worker evidence

Standalone default:
- standalone mode now uses UnifiedPipeline by default.
- pass `--legacy-router` to any command for temporary legacy fallback.

## L1/L2/L3 Use Cases

- Use case 1 (Code engine path): command-driven execution (`dispatch`, `auto`, `run`) with full L2/L3 pipeline.
- Use case 2 (Chat-directed execution): user chats with L1 (`crew chat`), L2 decides/forces execution path, L3 runs workers/tools.

Clarification rule:
- L1 returns final completion when done.
- If L3 emits unresolved `ask_user`, L1 returns only clarification questions and waits for user input.
- Next `crew chat` message auto-resumes the pending trace using saved `traceId` and prior plan artifacts.

## Quick Benchmarking

```bash
# Compare latency/pass behavior of presets
node scripts/benchmark-presets.mjs
```

`crew cost` now includes pipeline observability counters:
- `qa_approved`, `qa_rejected`, `qa_rounds_avg`
- `context_chunks_used`, `context_chars_saved_est`

## Context Flags

`chat` and `dispatch` accept these context injection flags:

- `--docs` — auto-retrieve relevant doc chunks via collections search
- `--cross-repo` — inject sibling repo context
- `--context-file <path>` — attach a file
- `--context-repo <path>` — attach git context from another repo
- `--stdin` — pipe stdin as context

## What Is Implemented

- Phase 1 (MVP): complete
- Phase 2 (Intelligence): complete
- Phase 3 (Polish/Launch): complete
- Phase 4 (Advanced): complete
- Phase 5 (3-Tier LLM Scale-Up): complete

See [ROADMAP.md](ROADMAP.md) for tracked completion.

## Testing

```bash
npm run build
npm run check
npm test
```

Latest local QA pass (2026-04-03):
- Build: passing
- Check: passing
- Tests: 765 passing, 0 failing

## Community

- 💬 [Join our Discord](https://discord.gg/crewswarm)
- 🐛 [Report a bug](https://github.com/crewswarm/crew-cli/issues)
- 💡 [Request a feature](https://github.com/crewswarm/crew-cli/discussions)

## Documentation

- [QUICKSTART.md](docs/QUICKSTART.md)
- [INSTRUCTION-STACK.md](docs/INSTRUCTION-STACK.md)
- [PERMISSIONS-MODEL.md](docs/PERMISSIONS-MODEL.md)
- [MODES-AND-FLAGS.md](docs/MODES-AND-FLAGS.md)
- [EXAMPLES.md](docs/EXAMPLES.md)
- [API.md](docs/API.md)
- [API-UNIFIED-v1.md](docs/API-UNIFIED-v1.md) — unified dashboard/CLI/headless contract
- [MCP-CLI-INTEGRATION.md](docs/MCP-CLI-INTEGRATION.md) — Codex/Cursor/Claude MCP setup
- [openapi.unified.v1.json](docs/openapi.unified.v1.json) — OpenAPI spec
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [CONTRIBUTING.md](docs/CONTRIBUTING.md)
- [SECURITY.md](docs/SECURITY.md)
