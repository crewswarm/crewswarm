# Social Launch Pack (Phase 3)

## Twitter/X Thread

1. We shipped `crew-cli`: multi-agent coding from your terminal with a safe diff sandbox.
2. Ask naturally with `crew chat "..."` and it routes to the right specialist agent.
3. All edits stage in `.crew/sandbox.json` first. Review before applying.
4. Compare alternatives with sandbox branches, then merge the winner.
5. Cost-aware dispatch with model comparison and spend guard.
6. Local correction capture + LoRA-style export dataset.
7. Try it: `npm i -g @crewswarm/crew-cli` and run `crew --help`.

## Reddit Post (r/LocalLLaMA / r/ChatGPT)

We built `crew-cli`, a terminal AI coding orchestrator that routes tasks to specialist agents and stages edits in a local sandbox before touching files.

Core idea: no blind file writes. You preview diff, branch alternatives, then apply.

Features:
- agent routing (`crew chat`)
- sandbox diff workflow (`crew preview`, `crew apply`)
- cost estimate + cheaper model suggestions (`crew estimate`)
- correction dataset capture (`crew correction`) + export (`crew tune --format lora`)

Would love feedback from folks using Aider/Codex/Claude Code workflows.

## YouTube Demo Script (2-3 min)

1. Intro (15s): "This is crew-cli, multi-agent orchestration in terminal."
2. Chat route (30s): run `crew chat "refactor auth middleware"` and show routed agent.
3. Sandbox flow (45s): show `crew preview`, `crew branch`, `crew merge`.
4. Cost flow (20s): show `crew estimate "add oauth login"` and dispatch guard.
5. Corrections flow (20s): `crew correction ...` then `crew tune --format lora`.
6. Close (10s): install command + repo link + ask for feedback.
