# crew-cli Benchmarks

## Overview

crew-cli includes three benchmark suites that measure execution quality across models and providers.

- **Full Pipeline Benchmark** — 6 TypeScript coding tasks through the complete L1→L2→L3 pipeline. Same model handles routing, planning, execution, review, and fixing. Tests true single-model capability.
- **L3 Executor Benchmark** — same tasks but calls the agentic executor directly, skipping L1/L2. Tests pure coding quality with tools.
- **L1 Router Benchmark** — 15 classification tasks. Tests whether a model correctly routes tasks to the right execution path.

## Results Summary (April 2026)

All results are **solo runs, single model on all pipeline layers**. No mixed models — the model being tested handles routing, planning, execution, review, and fixing.

### Full Pipeline — All Tests Pass

These models pass **every test** across all 6 tasks when running the complete pipeline solo:

| Model | Provider | Cost/Task | Notes |
|-------|----------|-----------|-------|
| Claude Opus 4.6 | Anthropic OAuth | ~$0.07 | Gold standard, most surgical diffs |
| Qwen 3.5 (397B) | Ollama cloud | FREE | Matches Opus on test pass rate |
| GPT-5.4 | OpenAI OAuth | ~$0.13 | Strong on all tasks |
| Claude Sonnet 4.6 | Anthropic OAuth | ~$0.06 | Best value paid model |
| GLM-5.1 | Ollama cloud | FREE | Best free model for fast tasks |
| Gemini 2.5 Flash | Google API | ~$0.003 | L3 executor only (98/100); bad as L2 planner (78/100) |

### Full Pipeline — Partial Pass

| Model | Provider | Cost/Task | Notes |
|-------|----------|-----------|-------|
| Nemotron 3 Super (120B) | Ollama cloud | FREE | 4/6 tasks perfect, fails multi-file-calculator |
| GPT-OSS 20B | Ollama cloud | FREE | 4/6 tasks perfect, fast (14-25s) |

### Key Finding: L3 vs Pipeline

Gemini 2.5 Flash scores **98/100 as L3 executor** (7-17s/task, $0.003) but only **78/100 in the full pipeline**. The L2 planner over-engineers simple tasks, writing 40+ lines for a 3-line fix. Gemini is an excellent coder but a poor planner.

**Optimal configuration**: use a strong model (Claude/GPT) for L1/L2 routing+planning, and a fast cheap model (Gemini/GLM) for L3 execution.

### L2 Planner: 14 models at 90/100

| Model | Score | ~$/Plan |
|-------|-------|---------|
| Claude / GPT-5.4 (OAuth) | 90 | $0 |
| GPT-OSS 20B (Groq) | 90 | $0.003 |
| Gemini 2.5 Flash Lite | 90 | $0.004 |
| DeepSeek Reasoner | 90 | $0.004 |
| Grok 3 Mini / Qwen3-32B | 90 | $0.005 |
| GLM-5 (Zen) | 90 | $0.02 |
| Kimi K2.5 (Zen) | 90 | $0.015 |

## Task Corpus

The quality benchmark runs 6 TypeScript tasks of increasing complexity:

1. **Bugfix: divide-by-zero** (easy) — fix divide to throw Error instead of returning Infinity
2. **Feature: modulo** (medium) — add modulo function + export + test
3. **Refactor: rename** (medium) — rename function across source + tests
4. **Multi-file: calculator** (hard) — create calculator module + tests + fix bug in dependency
5. **Multi-file: extract module** (hard) — extract function to new file, re-export, add test
6. **Bugfix: chain** (hard) — fix 2 bugs across 2 files, run all tests

Each task starts from a fresh fixture with pre-existing bugs and tests.

## Scoring

Each task is checked for:
- **Tests pass** — all expected test assertions succeed (50 points)
- **Type safety** — TypeScript compiles with zero errors (20 points)
- **No regressions** — previously passing tests still pass (15 points)
- **Diff efficiency** — minimal changes, scaled by task difficulty (15 points)

Test pass counts are the primary quality signal. The composite score is secondary.

## Running the Benchmarks

### Prerequisites

```bash
cd crew-cli
npm install && npm run build
```

Set provider credentials:
```bash
# API key providers
export GEMINI_API_KEY=...       # free tier available
export GROQ_API_KEY=gsk_...     # free tier available

# OAuth providers (Claude, GPT) — automatic via macOS Keychain
# Ollama models — no key needed, just `ollama pull model:cloud`
```

### Full Pipeline Benchmark (single model, all layers)

```bash
# Explicit provider routing
CREW_EXECUTION_MODEL=ollama:glm-5.1:cloud node scripts/benchmark-quality.mjs

# OAuth models
CREW_NO_OAUTH=false CREW_EXECUTION_MODEL=claude-opus-4-6 node scripts/benchmark-quality.mjs

# Custom timeout (default 600s)
CREW_BENCHMARK_TIMEOUT=300 CREW_EXECUTION_MODEL=gemini-2.5-flash node scripts/benchmark-quality.mjs
```

### L3 Executor Only (skip L1/L2 pipeline)

```bash
CREW_EXECUTION_MODEL=gemini-2.5-flash node scripts/benchmark-l3-executor.mjs
```

### L1 Router Accuracy

```bash
CREW_EXECUTION_MODEL=gemini-2.5-flash node scripts/benchmark-l1-router.mjs
```

Results auto-save to `benchmarks/results/` per model.

## Provider Routing

Use `provider:model` format for unambiguous routing:

```bash
CREW_EXECUTION_MODEL=ollama:glm-5.1:cloud   # Ollama cloud (free)
CREW_EXECUTION_MODEL=groq:llama-3.3-70b     # Groq (free)
CREW_EXECUTION_MODEL=claude:opus-4-6        # Anthropic OAuth
CREW_EXECUTION_MODEL=gemini:gemini-2.5-flash # Google API key
```

## Full Results

Full benchmark results with pricing: https://crewswarm.ai/benchmarks.html
