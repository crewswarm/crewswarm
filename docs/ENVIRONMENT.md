# Environment Variables

All variables can be set in `~/.crewswarm/crewswarm.json` under the `env` key, or exported before starting services. Visible in **Dashboard → Settings → Environment Variables**.

## Engine timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `CREWSWARM_ENGINE_IDLE_TIMEOUT_MS` | `300000` | Kill engine after this many ms of silence |
| `CREWSWARM_ENGINE_MAX_TOTAL_MS` | `1800000` | Absolute ceiling per engine task (30 min) |
| `PM_AGENT_IDLE_TIMEOUT_MS` | `900000` | PM loop subprocess idle timeout (pm-loop.mjs) |
| `PHASED_TASK_TIMEOUT_MS` | `600000` | Per-agent timeout in PM loop (pm-loop.mjs) |
| `CREWSWARM_DISPATCH_TIMEOUT_MS` | `300000` | ms before unclaimed dispatched task times out |
| `CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS` | `900000` | Timeout for claimed tasks (lib/runtime/config.mjs) |

## PM loop

| Variable | Default | Description |
|----------|---------|-------------|
| `PM_MAX_ITEMS` | `200` | Max roadmap items per run (pm-loop.mjs) |
| `PM_MAX_CONCURRENT` | `20` | Max parallel tasks (pm-loop.mjs) |
| `PM_CODER_AGENT` | `crew-coder` | Default coding agent |
| `PM_USE_QA` | `off` | Include crew-qa in pipeline |
| `PM_USE_SECURITY` | `off` | Include crew-security |
| `PM_USE_JUDGE` | `on` | Call crew-judge for CONTINUE/SHIP/RESET |
| `CREW_JUDGE_MODEL` | `groq/llama-3.3-70b-versatile` | Judge model |

## Engine routing

| Variable | Default | Description |
|----------|---------|-------------|
| `CREWSWARM_OPENCODE_ENABLED` | `off` | Route coding agents through OpenCode |
| `CREWSWARM_OPENCODE_MODEL` | `groq/moonshotai/kimi-k2-instruct-0905` | Model passed to `opencode run --model` in **engine passthrough** (overridden by chat payload `model` when set) |
| `CREWSWARM_ENGINE_LOOP` | `off` | Ouroboros LLM↔engine loop |
| `CREWSWARM_ENGINE_LOOP_MAX_ROUNDS` | `10` | Max STEP iterations |
| `CREWSWARM_GEMINI_CLI_ENABLED` | `off` | Route through Gemini CLI |
| `CURSOR_CLI_BIN` | auto (`~/.local/bin/agent` or `agent` on `PATH`) | Path to Cursor **`agent`** binary |
| `CREWSWARM_CURSOR_MODEL` | `composer-2-fast` | Default `--model` for Cursor CLI passthrough / gateway |
| `CURSOR_DEFAULT_MODEL` | — | Optional alternative default model (passthrough) |
| `CURSOR_API_KEY` | — | Cursor CLI auth without Keychain; see [CANONICAL/CURSOR-CLI.md](CANONICAL/CURSOR-CLI.md) |

## tmux-bridge sessions

Cross-agent pane communication for multi-wave pipelines. When enabled, agents can read each other's output and the session manager can hand off execution context between pipeline waves. Requires `tmux` installed (no other dependencies — the bridge is a built-in bash script at `scripts/tmux-bridge`).

| Variable | Default | Description |
|----------|---------|-------------|
| `CREWSWARM_TMUX_BRIDGE` | `off` | Enable persistent tmux sessions with cross-agent handoff. Requires `tmux`. Toggle via Dashboard → Settings → Engines. |
| `SMUX_BRIDGE_BIN` | `tmux-bridge` | Override path to tmux-bridge binary (default: auto-detected from PATH) |

## Ports

| Variable | Default |
|----------|---------|
| `CREW_LEAD_PORT` | `5010` |
| `SWARM_DASH_PORT` | `4319` |
| `WA_HTTP_PORT` | `5015` (whatsapp-bridge.mjs) |
| `STUDIO_WATCH_PORT` | `3334` (apps/vibe/watch-server.mjs) |

## Codebase index & RAG (crew-cli)

| Variable | Default | Description |
|----------|---------|-------------|
| `CREW_RAG_MODE` | `auto` | RAG mode: `auto` (semantic when ready, else keyword), `semantic`, `keyword`, `import-graph`, `off` |
| `CREW_EMBEDDING_PROVIDER` | `local` | Embedding provider: `local` (zero-cost hashed vectors), `openai` ($0.02/1K files), `gemini` (free tier) |
| `CREW_RAG_WORKER_BUDGET` | `4000` | Max tokens of RAG context injected per L3 worker (approximate) |
| `CREW_RAG_MAX_FILES` | `2000` | Max code files to index |
| `CREW_RAG_BATCH_SIZE` | `20` | Files per embedding batch |
| `CREW_RAG_MAX_FILES_LOAD` | `10` | Max files loaded per query result |
| `CREW_RAG_TOKEN_BUDGET` | `8000` | Total token budget for autoLoadRelevantFiles |

## Checkpointing (crew-cli)

| Variable | Default | Description |
|----------|---------|-------------|
| `CREW_AUTO_CHECKPOINT` | `true` | Auto-commit at task boundaries for easy rollback |
| `CREW_CHECKPOINT_INTERVAL_MS` | `60000` | Periodic git stash snapshot interval during long tasks (ms, 0 = disabled) |

## Background consciousness

| Variable | Default | Description |
|----------|---------|-------------|
| `CREWSWARM_BG_CONSCIOUSNESS` | `off` | Idle reflection loop for crew-main |
| `CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS` | `900000` | 15 min |
| `CREWSWARM_BG_CONSCIOUSNESS_MODEL` | `groq/llama-3.1-8b-instant` | Model for background cycle |
