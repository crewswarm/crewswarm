# crew-cli Benchmarks

## Overview

crew-cli includes two benchmark suites that measure execution quality across models and providers.

- **L3 Quality Benchmark** — scoped coding tasks (create, fix, refactor, test). Tests whether the execution quality engine produces correct, verified output.
- **L2 Planner Benchmark** — task decomposition quality (dependency chains, persona assignments, acceptance criteria).

## Results Summary

**L3 Execution: 29 models at 100/100**

| Model | Provider | ~Cost/Task |
|-------|----------|-----------|
| Claude (OAuth) | Anthropic | $0 |
| GPT-5.4 (OAuth) | OpenAI | $0 |
| GPT-OSS 20B | Groq | $0.0003 |
| Gemini 2.5 Flash Lite | Google | $0.0004 |
| DeepSeek Chat | DeepSeek | $0.001 |
| Grok 4-1 Fast | xAI | $0.001 |
| MiniMax M2.1 | OpenRouter | $0.001 |
| Gemini 2.5 Flash | Google | $0.002 |
| Kimi K2.5 | OpenRouter | $0.002 |
| Groq Llama 3.3 70B | Groq | $0.002 |
| Cerebras Qwen3-235B | Cerebras | $0.002 |
| GLM-5 | OpenCode/Zen | $0.003 |
| Claude Haiku 4.5 | Anthropic | $0.007 |
| GPT-5.4 | OpenAI | $0.02 |
| Claude Sonnet 4.6 | Anthropic | $0.02 |
| Claude Opus 4.6 | Anthropic | $0.03 |

Plus 13 more at 100/100: GPT-5.4 Mini/Nano, GPT-5/5.2, GLM-4.6/4.7, MiniMax M2.5, Kimi K2, Grok 3 Mini, Grok Code Fast, Big Pickle, DeepSeek Reasoner, Qwen3-32B.

**L2 Planner: 14 models at 90/100**

| Model | Score | ~$/Plan |
|-------|-------|---------|
| Claude / GPT-5.4 (OAuth) | 90 | $0 |
| GPT-OSS 20B (Groq) | 90 | $0.003 |
| Gemini 2.5 Flash Lite | 90 | $0.004 |
| DeepSeek Reasoner | 90 | $0.004 |
| Grok 3 Mini / Qwen3-32B | 90 | $0.005 |
| GLM-5 (Zen) | 90 | $0.02 |
| Kimi K2.5 (Zen) | 90 | $0.015 |

## Task Corpus (L3)

The quality benchmark runs 7 TypeScript tasks of increasing complexity. Each task is executed by the model through crew-cli's agentic loop with full tool access.

1. **Create README** — create a file with specific content (file creation + content accuracy)
2. **Create typed function** — export a typed `add(a, b)` function + summary doc (TypeScript, multi-file)
3. **Create utils + tests** — 3 exported functions (`clamp`, `slugify`, `truncate`) with types + test file with 2+ assertions each, run tests (implementation + testing + verification)
4. **Fix bug** — divide-by-zero returns Infinity instead of throwing. Fix function, update test, run tests (debugging + test update + verification)
5. **Refactor** — extract function to own file, update imports, verify build passes (refactoring + cross-file consistency)
6. **Fix wrong test** — test expects wrong output. Fix assertion to match implementation, run tests (test comprehension + verification)
7. **Calculator module** — import math functions, implement expression parser, write tests for all operators + error case (multi-file integration + parsing + testing)

## Scoring

Each task is checked for:
- **Correctness** — expected files exist with correct content
- **Type safety** — `tsc --strict` passes with zero errors
- **Tests pass** — all test assertions succeed
- **No regressions** — previously passing tasks still pass

Score = (tasks passed / total tasks) * 100. A score of 100 means all 7 tasks produced correct, type-safe, tested code.

## Why These Tasks

These are **scoped L3 execution tasks** — the kind that run in parallel after the L2 planner breaks complex work into units. They test whether the execution quality engine can make any model produce correct, verified code on bounded work.

They deliberately avoid full-feature complexity (that's the L2 planner benchmark). The question is: given a clear task, can the engine + model produce correct output? With the engine, 29 models answer yes.

## Running the Benchmarks

### Prerequisites

```bash
cd crew-cli
npm install && npm run build
```

Set at least one provider API key:
```bash
export GROQ_API_KEY=gsk_...    # free tier available
export GEMINI_API_KEY=...       # free tier available
```

### L3 Quality Benchmark

```bash
# Run against a specific model
CREW_PROVIDER=groq node scripts/benchmark-quality.mjs --model llama-3.3-70b

# Run against default model
node scripts/benchmark-quality.mjs

# Verbose output (keeps benchmark directories for inspection)
node scripts/benchmark-quality.mjs --verbose
```

### L2 Planner Benchmark

```bash
node scripts/benchmark-l2-planner.mjs
```

### Full Preset Sweep

```bash
# Run all presets (fast6, turbo6, balanced, quality) across models
node scripts/benchmark-presets.mjs
```

### Provider-Specific Runs

```bash
# Sweep multiple models on one provider
node scripts/benchmark-provider-compare.mjs

# Run against any OpenAI-compatible endpoint
OPENAI_API_BASE=http://localhost:11434/v1 node scripts/benchmark-quality.mjs --model llama3.1
```

## Benchmark Source

- Task corpus: `crew-cli/benchmarks/presets-corpus.json`
- Quality benchmark runner: `crew-cli/scripts/benchmark-quality.mjs`
- L2 planner benchmark: `crew-cli/scripts/benchmark-l2-planner.mjs`
- Preset sweep: `crew-cli/scripts/benchmark-presets.mjs`
- Fixture files: `crew-cli/benchmarks/fixture/`

## The Execution Quality Engine

The reason 29 models — from free (Groq GPT-OSS 20B) to premium (Claude Opus at $0.03/task) — all score 100/100 is the execution quality engine. 8 deterministic modules wrap every task:

1. **Failure memory** — blocks repeated mistakes after 1-2 failures
2. **Verification gate** — forces proof (tests pass, build succeeds) before "done"
3. **Patch critic** — catches unread edits, churn, scope creep every turn
4. **Action ranking** — steers model toward highest-value next action
5. **Task mode strategies** — different approaches for bugfix/feature/refactor/test repair
6. **Adaptive weights** — learns from session trajectory
7. **Structured history** — preserves full-fidelity state across context compaction
8. **Smart delegation** — picks right specialist per subtask

Without the engine, cheap models fail 40-60% of the time on multi-step coding tasks. They skip verification, hallucinate edits, and loop. The engine prevents those failure modes deterministically — no extra LLM calls.

## Full Results

Full benchmark results with pricing: https://crewswarm.ai/benchmarks.html
