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

## Ports

| Variable | Default |
|----------|---------|
| `CREW_LEAD_PORT` | `5010` |
| `SWARM_DASH_PORT` | `4319` |
| `WA_HTTP_PORT` | `5015` (whatsapp-bridge.mjs) |
| `STUDIO_WATCH_PORT` | `3334` (apps/vibe/watch-server.mjs) |

## Background consciousness

| Variable | Default | Description |
|----------|---------|-------------|
| `CREWSWARM_BG_CONSCIOUSNESS` | `off` | Idle reflection loop for crew-main |
| `CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS` | `900000` | 15 min |
| `CREWSWARM_BG_CONSCIOUSNESS_MODEL` | `groq/llama-3.1-8b-instant` | Model for background cycle |
