# crew-cli Guide

Terminal-first interface for crewswarm. Run builds, chat with agents, dispatch tasks, and manage pipelines -- all from the command line.

## Installation

crew-cli ships with the main crewswarm package:

```bash
npm install -g crewswarm
```

The `crew` command is now available globally.

From source (contributor setup):

```bash
cd crew-cli
npm install
npm run build
node bin/crew.js --help
```

## Requirements

- Node.js 20+
- Git
- For full features: crewswarm gateway running on `http://127.0.0.1:5010`

crew-cli works standalone (direct LLM calls) or connected to the full crewswarm stack. Standalone mode uses the unified pipeline by default.

## Quick start

```bash
# One-shot task
crew chat "build a REST API with Express and tests"

# Interactive REPL
crew repl

# Dispatch to a specific agent
crew dispatch crew-coder "fix the failing auth tests"

# Check system health
crew doctor
```

## Core commands

### `crew chat`

Send a message to the L1 router (crew-lead). It plans, decomposes, and dispatches automatically.

```bash
crew chat "refactor auth middleware"
crew chat "build auth API with tests" --modefast6
crew chat "add OAuth login" --preset quality
```

If the system needs clarification, it asks. Your next `crew chat` message auto-resumes the pending task using the saved trace ID.

Use `--new-task` to skip resume and start fresh:

```bash
crew chat "something unrelated" --new-task
```

### `crew dispatch`

Send a task directly to a named agent, bypassing the planner:

```bash
crew dispatch crew-coder "harden auth middleware"
crew dispatch crew-qa "run full test suite"
crew dispatch crew-coder "fix failing tests" --preset quality
```

### `crew run`

Unified pipeline -- multi-step builds with planning, parallel execution, and optional QA:

```bash
crew run -t "build auth API with tests"
```

Resume a failed or interrupted pipeline:

```bash
crew run --resume pipeline-<trace-id>
crew run --resume pipeline-<trace-id> --from-phase execute
```

### `crew repl`

Interactive multi-agent REPL with full tool access:

```bash
crew repl
crew repl --mode assist
```

Inside the REPL, you get streaming responses, session history, and access to all 34+ built-in tools. The session persists across turns.

`crew tui` is an alias for the same runtime with a terminal UI adapter.

### `crew explore`

Parallel speculative execution -- tries multiple approaches simultaneously:

```bash
crew explore "refactor database layer"
```

### `crew plan`

Generate a build plan without executing:

```bash
crew plan "add OAuth login" --parallel
```

### `crew preview` / `crew apply` / `crew rollback`

Sandbox diff workflow:

```bash
crew preview                    # see pending changes
crew apply --check "npm test"   # apply and verify
crew rollback                   # undo last apply
```

## Intelligence commands

```bash
crew map --graph                     # visual dependency graph
crew shell "list large files"        # natural language to shell command
crew docs "how does auth work"       # RAG search over project docs
crew blast-radius                    # impact analysis of current changes
crew memory "auth login"             # recall prior task memory
crew lsp check src/cli/index.ts      # TypeScript diagnostics
crew github "list open issues"       # natural language GitHub flows
crew github doctor                   # GitHub CLI health check
```

## Presets

Presets configure parallelism, QA rounds, and routing:

| Preset | Workers | QA | Best for |
|--------|---------|-----|----------|
| `fast6` | 6 parallel | 2 rounds | Speed-focused builds |
| `turbo6` | 6 parallel | Off | Max throughput, no QA |
| `balanced` | 4 parallel | 1 round | General use |
| `quality` | 3 parallel | 2 rounds + strict gates | Production code |

```bash
crew chat "build feature" --preset balanced
crew chat "quick fix" --modefast6
```

## Model selection

crew-cli picks a model automatically based on the task. Override with:

```bash
crew chat "build API" --model anthropic/claude-sonnet-4-20250514
```

Or set a default in config. Available providers: Anthropic, OpenAI, Google, Groq, Grok, DeepSeek, OpenRouter.

## Context injection

Attach extra context to any `chat` or `dispatch` command:

```bash
crew chat "fix this" --docs                    # auto-retrieve relevant doc chunks
crew chat "port this" --cross-repo             # inject sibling repo context
crew chat "review" --context-file src/auth.ts  # attach a specific file
crew chat "sync" --context-repo ../other-repo  # attach git context from another repo
echo "error log" | crew chat "debug this" --stdin  # pipe stdin as context
```

## Session resume

crew-cli saves session state automatically. If a task is interrupted or needs clarification:

```bash
# First message starts a task
crew chat "build auth system"
# System asks: "REST or GraphQL?"
# Next message resumes automatically
crew chat "REST with JWT"
```

Pipeline resume works the same way:

```bash
crew run -t "build feature"
# Pipeline fails at execute phase
crew run --resume pipeline-abc123 --from-phase execute
```

## Headless mode

For CI pipelines and scripts, use `--always-approve` to skip interactive prompts:

```bash
crew chat "fix lint errors" --preset fast6 --always-approve
crew ci-fix --check "npm test"
```

The `ci-fix` command runs iteratively: execute fix, run check, repeat until passing or max attempts.

## Configuration

crew-cli reads configuration from:

1. `~/.crewswarm/crewswarm.json` -- main config (agents, providers, settings)
2. Environment variables -- API keys and runtime flags
3. CLI flags -- override anything per-command

Key environment variables:

```bash
# Provider API keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
GROQ_API_KEY=gsk_...

# Pipeline tuning
CREW_QA_LOOP_ENABLED=true
CREW_QA_MAX_ROUNDS=2
CREW_CONTEXT_BUDGET_CHARS=7000
CREW_NO_ROUTER=true
```

See the [crew-cli README](../crew-cli/README.md) for the full list of pipeline runtime flags.

## Diagnostics

```bash
crew doctor
```

Checks Node.js, Git, API keys (10 providers), gateway health, MCP servers, and available updates. Takes about 3 seconds.

```bash
crew doctor --gateway http://custom-host:5010
```

## Cost tracking

```bash
crew cost
```

Shows per-session token costs across all providers, plus pipeline observability counters:
- `qa_approved`, `qa_rejected`, `qa_rounds_avg`
- `context_chunks_used`, `context_chars_saved_est`

## MCP server

crew-cli can serve as an MCP endpoint for other tools (Cursor, Claude Code, Codex):

```bash
crew serve --port 4317
```

This exposes a `/v1` API and `/mcp` endpoint. See [MCP-CLI-INTEGRATION.md](../crew-cli/docs/MCP-CLI-INTEGRATION.md) for setup details.

## Testing

```bash
cd crew-cli
npm run build
npm run check
npm test
```

Full QA suite:

```bash
npm run qa:full        # build + coverage + inventory + smoke
npm run qa:e2e         # gateway contract + engine matrix + PM loop
```

## Related docs

- [DASHBOARD-GUIDE.md](DASHBOARD-GUIDE.md) -- web UI guide
- [ARCHITECTURE.md](ARCHITECTURE.md) -- system diagram, ports, request flow
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) -- common issues and fixes
- [crew-cli README](../crew-cli/README.md) -- full CLI reference
- [crew-cli OVERVIEW.md](../crew-cli/docs/OVERVIEW.md) -- 1-minute summary
- [MODES-AND-FLAGS.md](../crew-cli/docs/MODES-AND-FLAGS.md) -- detailed flag reference
- [PERMISSIONS-MODEL.md](../crew-cli/docs/PERMISSIONS-MODEL.md) -- read/write/shell/approval behavior
