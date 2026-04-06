---
title: "crew-cli: The Multi-Model AI Coding CLI That Makes Claude Code, Codex, and Gemini CLI Work Together"
tags: "ai, opensource, productivity, devtools, grok"
published: false
canonical_url: "https://crewswarm.com/blog/crew-cli-multi-model-coding"
---

# crew-cli: The Multi-Model AI Coding CLI That Makes Claude Code, Codex, and Gemini CLI Work Together

Every AI coding CLI locks you into one provider. Claude Code only runs Anthropic models. Codex CLI is OpenAI-only (and doesn't even work on Intel Macs). Gemini CLI is Google-only with no multi-agent orchestration.

**What if you could use GPT-5.4 for planning, Grok 4.1 for cheap 2M-context execution, and Gemini Flash for routing — all from one terminal?**

That's crew-cli. An open-source agentic coding CLI with 34+ tools, real-time streaming across 10+ providers, and multi-agent swarm orchestration.

## Why Another CLI?

We weren't trying to replace Claude Code. We were trying to solve three problems it can't:

### 1. Provider Lock-in Kills You at Scale

Claude Code hits rate limits. Cursor spikes your CPU to 100% and costs $20/month before API fees. When any single provider goes down or throttles you, you stop working.

crew-cli has **10+ LLM providers**: OpenAI, Anthropic, Google, xAI (Grok), DeepSeek, Groq, Together, Fireworks, Moonshot, OpenRouter. If Claude is rate-limited, your next task automatically routes to GPT-5.4 or Grok.

### 2. You're Paying Too Much for Simple Tasks

Claude Code charges the same rate whether you're classifying an intent (10 tokens) or doing a multi-file refactor (50K tokens). That's wasteful.

crew-cli uses a **3-tier architecture**:

```
L1 (Router):   Groq Llama / Gemini Flash  → $0.075/M tokens
L2 (Brain):    GPT-5.4 / Grok 4.20        → $2-3/M tokens
L3 (Workers):  Gemini Flash / DeepSeek     → $0.28/M tokens
```

**Typical task cost: $0.02-0.08** vs Claude Code's $0.06+ for everything through one expensive model.

### 3. One Agent Can't Do Everything

Real engineering needs specialization. crew-cli orchestrates **20+ specialist agents** — crew-coder, crew-qa, crew-pm, crew-fixer, crew-security — that collaborate via a real-time WebSocket bus. Each has its own system prompt and can use a different model.

## The Killer Features

### `/model` — Built-in Benchmark Dashboard

No competitor has this. Type `/model` in the REPL and see every model's coding benchmark score, $/M pricing, and context window:

```
  Heavy Tier (L2 Brain):
  Model                    Score  In $/M  Out $/M  Context  Note
  ─────────────────────── ───── ─────── ──────── ──────── ──────────────
  gpt-5.4                  57.3   $3.00   $15.00     128K  #1 coding
  gemini-3.1-pro           55.5   $2.00   $12.00     200K  #2 coding
  claude-sonnet-4.6        50.9   $3.00   $15.00     200K
  grok-4.20-beta           42.2   $2.00    $6.00       2M  2M context
```

Switch models mid-conversation: `/model grok-4.20-beta` — instantly shows score, cost, and context window.

### Streaming Across All Providers

Every provider streams token-by-token. Not just the "supported" ones — we wrote custom SSE parsers for Gemini, OpenAI, Anthropic, Grok, DeepSeek, Groq, and OpenRouter. You see thinking in real-time, just like Claude Code, but for any model.

### `crew doctor` — Environment Diagnostics in 3 Seconds

```bash
$ crew doctor
  ✓ Node.js >= 20 — Detected v24.10.0
  ✓ Git installed
  ✓ LLM API keys — 6 provider(s): Gemini, Groq, Grok, DeepSeek, OpenAI, Anthropic
  ✓ CrewSwarm gateway reachable
  ✓ CLI update status — Up to date
```

When API keys are missing, it suggests the cheapest providers first (Gemini free tier, Groq free tier).

### 34+ Built-in Tools

File I/O, bash shell, git operations, LSP diagnostics, web search, web fetch, Docker sandbox, memory persistence, browser debugging — more tools than any competitor CLI.

### Edge Case Resilience

- **Re-reads files on edit mismatch** — when `String not found`, the executor re-reads the file and returns fresh content to the LLM instead of blindly retrying
- **Stale response detection** — stops agents that repeat the same answer instead of wasting turns
- **Auto-retry with correction** — whitespace trimming, path normalization, up to 3 attempts

## Why Grok Users Should Care

**xAI doesn't have an official CLI.** There's no `grok chat` equivalent to `claude code` or `gemini cli`.

crew-cli **is** the Grok CLI:

- Grok 4.1 Fast: **$0.20/M input** with **2 million tokens of context** — that's your entire codebase in one prompt
- Grok 4.20 Beta: 42.2 coding score at $2/M — 3x cheaper than Claude with competitive quality
- Works with xAI API keys out of the box: `export XAI_API_KEY=your-key && crew chat`

If you're already paying for xAI API access, crew-cli gives you a production-grade CLI for free.

## The Vibe Play: Multi-CLI from One UI

crew-cli includes **crewswarm Studio (Vibe)** — a full-screen IDE with Monaco editor + agent chat. Think Cursor, but:

- **Pick any model** — not locked to Anthropic or OpenAI
- **Route around rate limits** — if Claude is throttled, keep working with GPT-5.4 or Grok
- **Works on Intel Macs** — Codex CLI doesn't. crew-cli does
- **No GPU spikes** — CLIs don't run VS Code's heavy framework. Your CPU stays at 5%, not 100%

## Comparison Table

| Feature | crew-cli | Claude Code | Codex CLI | Gemini CLI | Cursor |
|---|---|---|---|---|---|
| Multi-model routing | ✅ 10+ | ❌ Anthropic | ❌ OpenAI | ❌ Google | ✅ |
| Built-in tools | ✅ 34+ | ~15 | ~10 | ~12 | ~20 |
| Parallel agents | ✅ 21 | ❌ | ❌ | ❌ | ❌ |
| Streaming | ✅ All | ✅ | ✅ | ✅ | ✅ |
| Diagnostics CLI | ✅ doctor | ❌ | ❌ | ❌ | ❌ |
| Benchmark dashboard | ✅ /model | ❌ | ❌ | ❌ | ❌ |
| Intel Mac support | ✅ | ✅ | ❌ | ✅ | ✅ |
| Cost per task | ~$0.03 | ~$0.06 | ~$0.05 | ~$0.04 | $20/mo+ |

## Get Started

```bash
git clone https://github.com/crewswarm/crewswarm.git
cd crewswarm/crew-cli
npm install && npm run build

# Set at least one API key (Gemini is free)
export GEMINI_API_KEY=your-key

# Start coding
node bin/crew.js chat "refactor the auth middleware"

# Or use the REPL
node bin/crew.js repl
```

**Docker (servers/teams):**
```bash
docker pull crewswarm/crewswarm:latest
docker compose up -d
```

## What's Next

- npm publish (`npm i -g crewswarm-cli`)
- More OpenRouter models (MiniMax, Xiaomi MiMo, GLM-5)
- Voice mode for hands-free coding

---

*crew-cli is open-source under ISC license. Built for developers who want CLI-speed execution, IDE-quality output, and the freedom to pick any model.*

*Star us on GitHub: [crewswarm/crewswarm](https://github.com/crewswarm/crewswarm)*
