# Model Ratings — Coding Benchmarks (Groq & Common Models)

Use this when recommending models for OpenCode, crew-lead fallback, or agent assignment. @@READ_FILE this file when the user asks "which model is best" or "model ratings" or "benchmarks."

---

## SWE-Bench Verified (real-world GitHub PR fixes — 500 instances)

| Model | SWE-Bench Verified | Notes |
|-------|-------------------|-------|
| Claude Sonnet 4 | 72.7% | Top proprietary |
| Claude Opus 4 | 72.5% | Top proprietary |
| **MiniMax-M2.5** | **80.2%** | Best open-source; fast inference; NVIDIA NIM / Ollama Cloud |
| **Kimi K2-Instruct-0905** | **69.2%** | Best Groq coding model; 1T MoE, 32B active; 256K context |
| Kimi K2-Instruct-0711 | 65.8% | Older K2 |
| **GPT-OSS-120B** | **62.4%** | Groq; 120B, ~500 tok/s; top open-source on Groq |
| Qwen3-Coder (various) | ~50–60% | 32B variant available on Groq |

---

## HumanEval (function synthesis — 164 problems)

| Model | HumanEval | Notes |
|-------|-----------|-------|
| Kimi K2-Instruct | 93.3% | Strong on short coding tasks |
| **Mistral Codestral 25.01** | **86.6%** | 256K ctx, scaffolding/tests; leader in 22B class |
| GPT-OSS-120B | competitive | Exact % varies by eval |
| Llama 3.3 70B | ~50%+ | Solid all-rounder, not coding-specialized |
| Llama 3.1 8B | lower | Fast, light; PM/simple tasks only |

---

## 16x Eval (human-rated coding tasks, 0–10 scale)

| Model | Avg Rating | vs Open-Source | Notes |
|-------|------------|----------------|-------|
| Claude Opus 4 | 9.2 | — | Top tier |
| Claude Sonnet 4 | 8.75 | — | — |
| Grok 4 | 8.4 | — | — |
| **GPT-OSS-120B** | **8.3** | **#1 open-source** | Verbose; beats Kimi K2, Qwen3 |
| GPT-4.1 | 8.2 | — | — |
| **Mistral Large 3 2512** | **91%** | Benchable | 675B MoE, 256K, cheap $0.50/$1.50 |
| Kimi K2 | 7.35 | #2 | Strong on some tasks, weak on TS narrowing |
| Qwen3 Coder | 6.8 | #3 | — |
| Gemini 2.5 Pro | 7.25 | — | — |

---

## OpenCode Zen (opencode/…)

OpenCode's model pool via Zen API. Purpose-built for agentic coding.

| Model ID | Best for | Context | Notes |
|----------|----------|---------|-------|
| `opencode/big-pickle` | **Coding, reasoning, general** | 200K | **Free** — no per-token cost; rate limited when heavy |
| `opencode/gpt-5.2-codex` | **Flagship coding** | 200K | Best OpenCode coding model |
| `opencode/gpt-5.1-codex-mini` | Lighter coding | 200K | Faster, cheaper |
| `opencode/glm-5-free` | Fallback when rate limited | — | Low quality; use when big-pickle hits limit |

**Summary:** Big Pickle = free, 200K ctx, strong reasoning. Only constraint is rate limit on heavy use.

---

## Minimax (via NVIDIA NIM or Ollama Cloud)

**MiniMax-M2.5: 80.2% SWE-Bench** — top open-source coding model. 51.3% Multi-SWE-Bench. Fast inference.

| Model ID | Best for | Notes |
|----------|----------|-------|
| `nvidia/minimaxai/minimax-m2.5` | **Coding** | 80.2% SWE-Bench; when available on NIM |
| `nvidia/minimaxai/minimax-m2` | **Coding** | NVIDIA NIM (Oct 2025); 230B MoE, 10B active |
| `ollama/minimax-m2-cloud` | Coding | Via Ollama Cloud (ollama.com API key) |

**Wiring:** Add Minimax to `~/.crewswarm/crewswarm.json` providers. NVIDIA: `baseUrl: https://integrate.api.nvidia.com/v1`, `apiKey` from NVIDIA. Ollama Cloud: separate provider with `https://ollama.com` + `OLLAMA_API_KEY`.

**Summary:** 80.2% SWE-Bench (M2.5). Best open-source coding. NVIDIA NIM or Ollama Cloud. Needs API key.

---

## Ollama Cloud (Sept 2025)

Cloud models **proxy through your local Ollama** (localhost:11434). Local daemon offloads inference to Ollama's servers — no local GPU needed. Same API; add `-cloud` to model IDs.

| Model ID | Context | Notes |
|----------|---------|-------|
| `ollama/gpt-oss:120b-cloud` | 200K | Same as Groq gpt-oss-120b; cloud-hosted |
| `ollama/deepseek-v3.1:671b-cloud` | 160K | 671B params |
| `ollama/qwen3-coder:480b-cloud` | 200K | Code-focused |
| `ollama/kimi-k2:1t-cloud` | 256K | Kimi K2 via cloud |
| `ollama/minimax-m2-cloud` | — | MiniMax-M2 |

**Setup:** `ollama signin`, `ollama pull gpt-oss:120b-cloud`. Uses existing `ollama` provider (localhost:11434) — **already wired** in CrewSwarm. No extra config.

**Summary:** Proxies through local Ollama. Pull cloud model, use it. Works with current CrewSwarm setup.

---

## Groq Models — Quick Pick List

| Model ID | Best for | SWE-Bench | HumanEval | Speed |
|----------|----------|-----------|-----------|-------|
| `groq/moonshotai/kimi-k2-instruct-0905` | **Coding, OpenCode fallback** | 69.2% | 93.3% | 200+ tok/s |
| `groq/openai/gpt-oss-120b` | **Coding, complex tasks** | 62.4% | competitive | 500 tok/s |
| `groq/llama-3.3-70b-versatile` | General, fast, 128K ctx | ~50% | ~50% | fast |
| `groq/qwen/qwen3-32b` | Coding (if qwen allowed) | ~55% | high | fast |
| `groq/llama-3.1-8b-instant` | PM, simple tasks only | low | low | fastest |
| `groq/meta-llama/llama-4-maverick-17b-128e-instruct` | Newer Llama 4 | TBD | TBD | fast |
| `groq/meta-llama/llama-4-scout-17b-16e-instruct` | Newer Llama 4 | TBD | TBD | fast |

---

## Mistral Models

| Model ID | Best for | HumanEval | Context | Notes |
|----------|----------|----------|---------|-------|
| `mistral/codestral` | **Coding, tests, scaffolding** | 86.6% | 256K | 22B, coding-specialized |
| `mistral/mistral-large-2512` | **General + coding, long context** | 91% | 256K | 675B MoE, cheap $0.50/$1.50 |
| `mistral/mistral-large` | General | — | 128K | Solid all-rounder |

---

## Google Gemini

| Model ID | Best for | Context | Notes |
|----------|----------|---------|-------|
| `google/gemini-2.5-pro-preview-03-25` | **Reasoning, coding** | 1M | 7.25 on 16x; strong instruction following |
| `google/gemini-2.0-flash` | **Free tier, fast general** | 1M | $0.075/$0.30; excellent for most tasks |
| `google/gemini-2.0-flash-lite` | Lightest, fastest | 1M | Free; simple tasks |
| `google/gemini-1.5-pro` | **Long context** | **2M** | Largest context; whole-repo analysis |
| `google/gemini-1.5-flash` | Reliable fallback | 1M | Free tier; well-tested |

---

## Cerebras — Fast Only

Cerebras excels at speed (500+ tok/s) but models are smaller. Use **only for speed-critical, light tasks**: PM quick breakdowns, Telegram replies, simple fix triage. Not for heavy coding, security audit, or copy.

| Model ID | Use for |
|----------|---------|
| `cerebras/llama3.1-8b` | PM speed, Telegram, simple fixes, quick smoke checks |

---

## Top 10 by Role

Models ranked best → good. Use provider/model format (e.g. groq/kimi-k2-instruct-0905). Assumes you have Groq, OpenAI, Anthropic, DeepSeek, Mistral, Cerebras, Google, xAI available.

### crew-coder / crew-coder-front / crew-coder-back (coding)
1. openai/gpt-5.3-codex — OpenCode default, purpose-built for agentic coding
2. opencode/big-pickle — Free; 200K ctx, strong reasoning; rate limited when heavy
3. anthropic/claude-sonnet-4 — Top instruction following, 72.7% SWE-Bench
4. nvidia/minimaxai/minimax-m2 — 80.2% SWE-Bench (M2.5); NIM has M2; best open-source (NVIDIA key)
5. groq/moonshotai/kimi-k2-instruct-0905 — 69.2% SWE-Bench, 93% HumanEval, personality
6. groq/openai/gpt-oss-120b — 62.4% SWE-Bench, 500 tok/s, #1 open-source on 16x
7. mistral/codestral — 86.6% HumanEval, 256K, scaffolding/tests
8. mistral/mistral-large-2512 — 91% coding, 256K, cheap
9. deepseek/deepseek-chat — Strong value, Claude-tier
10. google/gemini-2.5-pro-preview-03-25 — 7.25 on 16x, strong reasoning

### crew-frontend (CSS/design)
1. anthropic/claude-sonnet-4 — Best design-system reasoning
2. groq/moonshotai/kimi-k2-instruct-0905 — Strong + good at creative layout
3. openai/gpt-5.3-codex — Full implementation
4. mistral/mistral-large-2512 — 256K, good design reasoning, cheap
5. groq/openai/gpt-oss-120b — Fast, capable
6. mistral/codestral — 256K for large style files
7. groq/llama-3.3-70b-versatile — Good all-rounder
8. google/gemini-2.0-flash — Free tier, fast, good layout
9. deepseek/deepseek-chat — Value pick
10. anthropic/claude-haiku-4-5 — Quick iterations

### crew-qa (testing & audit)
1. anthropic/claude-sonnet-4 — Best attention to detail
2. groq/moonshotai/kimi-k2-instruct-0905 — Thorough, personality helps feedback
3. mistral/codestral — 86.6% HumanEval, excels at test gen
4. openai/gpt-5.3-codex — Strong at test gen
5. groq/openai/gpt-oss-120b — Fast audit
6. deepseek/deepseek-reasoner — Reasoning for edge cases
7. mistral/mistral-large-2512 — Solid, 256K
8. google/gemini-2.0-flash — Free tier, test gen
9. groq/llama-3.3-70b-versatile — Solid
10. cerebras/llama3.1-8b — Fast only: quick smoke checks

### crew-fixer (bug fixing)
1. deepseek/deepseek-reasoner — Best root-cause reasoning
2. anthropic/claude-sonnet-4 — Strong debugging
3. openai/gpt-5.3-codex — Coding + reasoning
4. groq/moonshotai/kimi-k2-instruct-0905 — Good at repro + fix
5. groq/openai/gpt-oss-120b — Fast
6. xai/grok-3 — Reasoning
7. google/gemini-2.5-pro-preview-03-25 — Reasoning for root cause
8. anthropic/claude-haiku-4-5 — Fast triage
9. groq/llama-3.3-70b-versatile — Reliable
10. cerebras/llama3.1-8b — Quick simple fixes

### crew-pm (planning & roadmaps)
1. openai/gpt-5.3-codex — Best task decomposition
2. anthropic/claude-sonnet-4 — Clear roadmaps
3. perplexity/sonar-pro — Web search for research
4. mistral/mistral-large-2512 — 256K, structured, cheap
5. groq/llama-3.3-70b-versatile — Good quality
6. groq/moonshotai/kimi-k2-instruct-0905 — Structured output
7. deepseek/deepseek-reasoner — Planning benchmark
8. google/gemini-2.0-flash — Free tier, fast planning
9. groq/openai/gpt-oss-120b — Solid
10. cerebras/llama3.1-8b — Fast only: speed over depth

### crew-security (security review)
1. anthropic/claude-sonnet-4 — Best OWASP awareness
2. deepseek/deepseek-reasoner — Reasoning for vuln chains
3. openai/gpt-5.3-codex — Code + security
4. xai/grok-3 — Strong reasoning
5. groq/moonshotai/kimi-k2-instruct-0905 — Thorough
6. mistral/mistral-large-2512 — Solid, 256K
7. groq/openai/gpt-oss-120b — Capable
8. mistral/codestral — Code review
9. groq/llama-3.3-70b-versatile — Baseline
10. anthropic/claude-haiku-4-5 — Fast scan

### crew-copywriter (writing & docs)
1. anthropic/claude-sonnet-4 — Best prose, human voice
2. anthropic/claude-opus-4 — Top creative
3. groq/moonshotai/kimi-k2-instruct-0905 — Personality, engaging
4. openai/gpt-4.1 — Strong writing
5. google/gemini-2.0-flash — Free tier, good prose
6. groq/llama-3.3-70b-versatile — Good tone
7. mistral/mistral-large-2512 — European, polished
8. deepseek/deepseek-chat — Value
9. xai/grok-3 — Bold voice
10. anthropic/claude-haiku-4-5 — Fast drafts

### crew-github (git & PRs)
1. openai/gpt-5.3-codex — Best at code + commit messages
2. anthropic/claude-sonnet-4 — Clear PR descriptions
3. groq/moonshotai/kimi-k2-instruct-0905 — Good summaries
4. groq/openai/gpt-oss-120b — Fast
5. google/gemini-2.0-flash — Free tier, clear messages
6. groq/llama-3.3-70b-versatile — Solid
7. anthropic/claude-haiku-4-5 — Quick
8. deepseek/deepseek-chat — Value
9. mistral/codestral — Code-aware
10. groq/llama-3.1-8b-instant — Light PRs

### crew-main / crew-lead (general coordinator)
1. anthropic/claude-sonnet-4 — Best synthesis
2. groq/moonshotai/kimi-k2-instruct-0905 — Personality + coding
3. openai/gpt-5.3-codex — Agentic
4. mistral/mistral-large-2512 — 256K, cheap, solid
5. groq/llama-3.3-70b-versatile — 128K, no trim
6. google/gemini-2.0-flash — Free tier, solid coordination
7. groq/openai/gpt-oss-120b — Fast
8. deepseek/deepseek-chat — Value
9. anthropic/claude-haiku-4-5 — Fast fallback
10. cerebras/llama3.1-8b — Fast only: quick replies, simple fixes

### crew-seo
1. perplexity/sonar-pro — Web search + SERP awareness
2. anthropic/claude-sonnet-4 — Structured data, schema
3. groq/moonshotai/kimi-k2-instruct-0905 — Research
4. openai/gpt-4.1 — Long context for pages
5. google/gemini-1.5-pro — 2M context
6. groq/llama-3.3-70b-versatile — Solid
7. deepseek/deepseek-chat — Value
8. anthropic/claude-haiku-4-5 — Fast
9. mistral/mistral-large-2512 — Content
10. groq/openai/gpt-oss-120b — Alternative

### crew-ml
1. anthropic/claude-sonnet-4 — Best at pipeline design
2. openai/gpt-5.3-codex — Code + reasoning
3. groq/moonshotai/kimi-k2-instruct-0905 — Strong
4. deepseek/deepseek-reasoner — Math/reasoning
5. groq/openai/gpt-oss-120b — Fast
6. groq/llama-3.3-70b-versatile — Solid
7. mistral/codestral — Code
8. anthropic/claude-haiku-4-5 — Quick
9. xai/grok-3 — Reasoning
10. google/gemini-1.5-pro — Long context for data

### crew-telegram
1. groq/moonshotai/kimi-k2-instruct-0905 — Personality, engaging
2. anthropic/claude-haiku-4-5 — Fast, concise
3. mistral/mistral-large-2512 — Good tone, 256K, cheap
4. google/gemini-2.0-flash — Free tier, fast, engaging
5. groq/llama-3.3-70b-versatile — Good tone
6. anthropic/claude-sonnet-4 — Quality
7. deepseek/deepseek-chat — Value
8. groq/openai/gpt-oss-120b — Solid
9. mistral/codestral — Coding replies
10. cerebras/llama3.1-8b — Fast only: quick replies

---

## Quick Recommendations

- **OpenCode primary (free):** `opencode/big-pickle` — 200K ctx, no per-token cost; rate limited when heavy
- **Best open-source coding:** `nvidia/minimaxai/minimax-m2` — MiniMax-M2 on NIM; M2.5 hits 80.2% SWE-Bench
- **OpenCode fallback:** `groq/moonshotai/kimi-k2-instruct-0905` or `groq/openai/gpt-oss-120b`
- **crew-lead fallback:** `groq/llama-3.3-70b-versatile` (128K, no trim) or `groq/moonshotai/kimi-k2-instruct-0905`
- **Coding:** Prefer kimi-k2-instruct-0905 or gpt-oss-120b over llama-3.3-70b
- **PM:** llama-3.1-8b-instant (speed) or llama-3.3-70b (quality)
- **Google free tier:** `google/gemini-2.0-flash` — PM, main, telegram, QA, copywriter
- **Copywriter:** Claude Sonnet 4 for best prose; Kimi for personality

---

*Sources: 16x Eval, SWE-bench, Groq docs, Libril writing comparison, PlanGenLLMs. Update when new benchmarks release.*
