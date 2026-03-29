# crew-cli Modes And Flags

This is the canonical guide to the few knobs that matter most in day-to-day use.

## Recommended defaults

For most users:

- REPL mode: `assist`
- engine: `auto`
- model: leave unset unless you need reproducibility
- preset: `balanced`

Use these first:

- `crew repl --mode assist`
- `crew chat "fix auth tests" --preset balanced`
- `crew dispatch crew-coder "harden auth middleware" --preset quality`

## The important knobs

### 1. REPL mode

- `manual`
  - lowest automation
  - no execution confirmation
  - best when you want direct control

- `assist`
  - recommended default
  - memory/RAG on
  - confirms before heavier execution

- `autopilot`
  - highest automation
  - auto-apply may occur
  - best for low-friction batch work when you trust the environment

### 2. Engine

Use `--engine` or `/engine` when you want a specific runtime:

- `auto`
- `cursor`
- `claude`
- `gemini`
- `codex`
- `crew-cli`

If you do not care which runtime handles a task, leave it on `auto`.

### 3. Model

Use `--model` or `/model` only when you need a specific model for:

- reproducibility
- benchmarking
- cost control
- provider-specific behavior

Otherwise, let the configured runtime defaults work.

### 4. Presets

Presets are the easiest way to change quality/speed tradeoffs without touching low-level flags.

- `fast6`
  - speed-focused
  - 6 workers
  - QA on

- `turbo6`
  - maximum throughput
  - 6 workers
  - QA off

- `balanced`
  - recommended default
  - 4 workers
  - mixed speed/quality

- `quality`
  - strongest validation path
  - fewer workers
  - stricter QA and gates

## Advanced flags

These are powerful, but most users should not start here:

- `--fallback-model`
- `--retry-attempts`
- `--legacy-router`
- `CREW_TOOL_MODE`
- `CREW_NO_ROUTER`
- `CREW_DUAL_L2_ENABLED`
- `CREW_QA_LOOP_ENABLED`

If you are touching these often, you are doing advanced tuning, not normal usage.

## Mental model

If you want a simple rule:

- choose a mode for how much autonomy you want
- choose an engine only when you need a specific runtime
- choose a model only when you need a specific model
- use presets instead of stacking many low-level flags

## Related docs

- [INSTRUCTION-STACK.md](./INSTRUCTION-STACK.md)
- [PERMISSIONS-MODEL.md](./PERMISSIONS-MODEL.md)
- [REPL-MODES-AND-RELIABILITY.md](./REPL-MODES-AND-RELIABILITY.md)
