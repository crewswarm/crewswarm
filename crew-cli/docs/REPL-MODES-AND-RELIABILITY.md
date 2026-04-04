# REPL Modes And Reliability

This document defines how `manual`, `assist`, and `autopilot` work, plus the core reliability gates that keep the CLI stable.

## Mode Contract

1. `manual`
- Chat + dispatch/code execution.
- No memory/RAG injection into task prompts.
- No execution confirmation prompt.
- Auto-apply forced off.

2. `assist`
- Chat + dispatch/code execution.
- Memory/RAG injection enabled.
- Confirmation prompt before non-chat execution.
- Auto-apply off.

3. `autopilot`
- Memory/RAG injection enabled.
- Auto-apply on.
- In `standalone` interface mode, runs full unified pipeline (`L1 -> L2 -> L3`) instead of single local execution path.

Use `/mode-info` in REPL for live explanation.

## Structured JSON Hardening

Structured outputs now go through shared normalization:

1. Extract JSON from raw/fenced output.
2. Repair common model breakage (control chars, bad newlines, trailing commas, brace mismatch).
3. If parse still fails, run deterministic repair pass (`CREW_JSON_REPAIR_MODEL` if set; otherwise provider-aware fallback).

This is applied to:

1. Unified router decisions.
2. Dual-L2 planner outputs (planning artifacts, decomposer graph, policy validator).
3. Legacy orchestrator LLM router path.

## Tool Visibility

Use `/tools` in REPL for current capability matrix:

1. Standalone vs connected execution boundary.
2. Local sandbox/write behavior.
3. Gateway-backed tool availability.
4. Memory/RAG and LSP availability.

## Cost Safety Basics

In `assist` mode, non-chat execution shows a confirmation prompt with an estimated cost before running.

For stricter gating, use env:

- `CREW_QA_LOOP_ENABLED=true`
- `CREW_QA_MAX_ROUNDS=2`
- `CREW_DUAL_L2_ENABLED=true`
- `CREW_MAX_PARALLEL_WORKERS=<n>`

## Mode Cycling

`/mode` cycles through `manual` -> `assist` -> `autopilot` deterministically. `Shift+Tab` does the same from the prompt. The active mode is shown in the REPL prompt prefix.

## Model Stack (`/stack`)

The `/stack` command manages which model is assigned to each tier of the pipeline.

- `/stack` with no arguments shows the current L1/L2/L3 models plus QA, fixer, and review assignments.
- `/stack l1|l2|l3|qa|fixer|review <model>` sets the model for a specific tier.
- `/stack <model>` is a shortcut that sets L1 (the most common change).
- `/stack bench` prints a benchmark table comparing latency and cost across configured models.
- `/model` and `/models` are backwards-compatible aliases for `/stack`.

## Ghost-Text Autocomplete

When you type `/` in the REPL, inline gray suggestion text appears for known slash commands. Press the Right arrow key to accept the suggestion. Tab triggers standard readline completion for partial matches.

## Tool Activity Lines

Every tool call executed by the agent prints a gray activity line in the REPL output, for example:

```
⚙ Reading src/index.ts
⚙ Writing src/middleware/auth.ts
```

This covers all 45 built-in tools. The `ask_user` tool is suppressed (the REPL handles user interaction directly).

## Known Limits

1. Piped REPL automation is now more stable, but fully interactive commands like `/stack` still require a real TTY.
2. Tool usage is still path-dependent:
- wiring in that execution path
- permissions
- router prompt selection
- parser acceptance of returned structure
