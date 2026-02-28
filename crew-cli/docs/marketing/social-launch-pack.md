# Social Launch Pack (Phase 3)

## Twitter/X Thread

1. We shipped `crew-cli`: multi-agent coding from your terminal with a safe diff sandbox.
2. Ask naturally with `crew chat "..."` and it routes to the right specialist agent.
3. All edits stage in `.crew/sandbox.json` first. Review before applying.
4. Compare alternatives with sandbox branches, then merge the winner.
5. Run `crew review --strict` to fail CI on high-severity risks.
6. Headless mode ships JSONL artifacts: `crew --headless --json --out .crew/headless-run.jsonl`.
7. Bound token/context growth with `--max-context-tokens` budget controls.
8. Validate MCP config with `crew mcp doctor` before agents run.
9. Try it: `npm i -g @crewswarm/crew-cli` and run `crew --help`.

## Reddit Post (r/LocalLLaMA / r/ChatGPT)

We built `crew-cli`, a terminal AI coding orchestrator that routes tasks to specialist agents and stages edits in a local sandbox before touching files.

Core idea: no blind file writes. You preview diff, branch alternatives, then apply.

Features:
- agent routing (`crew chat`)
- sandbox diff workflow (`crew preview`, `crew apply`)
- strict review gate (`crew review --strict`)
- headless JSONL artifacts for CI (`--headless --json --out`)
- context budget guard (`--max-context-tokens`)
- MCP preflight checks (`crew mcp doctor`)

Would love feedback from folks using Aider/Codex/Claude Code workflows.

## YouTube Demo Script (2-3 min)

1. Intro (15s): "This is crew-cli, multi-agent orchestration in terminal."
2. Chat route (30s): run `crew chat "refactor auth middleware"` and show routed agent.
3. Sandbox flow (45s): show `crew preview`, `crew branch`, `crew merge`.
4. Review flow (20s): show `crew review --strict` in a pre-commit pass.
5. CI flow (20s): run headless command with JSONL `--out` artifact.
6. Ops flow (15s): run `crew mcp doctor` and mention context budgets.
7. Close (10s): install command + repo link + ask for feedback.
