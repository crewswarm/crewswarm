# Model Recommendations

All providers below are pre-configured in `~/.crewswarm/crewswarm.json`. To swap a model for any agent, change its `"model"` field — no code changes required. The `OPENCREW_OPENCODE_MODEL` env var overrides the model used by OpenCode (the primary coding executor).

---

## Your Current Setup

| Agent | Current Model | Provider |
|---|---|---|
| `crew-main` (Quill) | `openai/gpt-5.1-codex` | OpenCode |
| `crew-coder` (Codex) | `groq/llama-3.3-70b-versatile` | Groq |
| `crew-pm` (Planner) | `groq/llama-3.3-70b-versatile` | Groq |
| `crew-qa` (Tester) | `groq/llama-3.3-70b-versatile` | Groq |
| `crew-fixer` (Debugger) | `groq/llama-3.3-70b-versatile` | Groq |
| `security` (Guardian) | `groq/llama-3.3-70b-versatile` | Groq |
| **Default primary** | `opencode/big-pickle` | OpenCode |
| **Default fallbacks** | `anthropic/claude-haiku-4-5` → `anthropic/claude-sonnet-4-20250514` | Anthropic |

---

## All Configured Providers

### OpenCode (`opencode/…`)
OpenCode's proprietary model pool — accessed via `https://opencode.ai/zen/v1` with your Zen API key. These are wrappers around underlying models with extended context and tool support.

| Model ID | Alias | Context | Notes |
|---|---|---|---|
| `opencode/big-pickle` | `big-pickle` | 200K | Default primary for all agents |
| `opencode/gpt-5.2-codex` | — | 200K | Flagship coding model |
| `opencode/gpt-5.1-codex-mini` | — | 200K | Lighter/faster Codex |
| `opencode/claude-opus-4-6` | — | 200K | Claude Opus via OpenCode |
| `opencode/glm-5-free` | — | — | **Free tier** — current `OPENCREW_OPENCODE_MODEL` default; low quality |

**Pricing:** Covered by your Zen subscription. No per-token billing.

---

### Groq (`groq/…`)
Ultra-fast inference. Free tier is generous for most swarm workloads. Currently powering all 5 specialist agents.

| Model ID | Alias | Context | Notes |
|---|---|---|---|
| `groq/llama-3.3-70b-versatile` | `llama70` | 128K | Best Groq option for coding; **free tier** |
| `groq/meta-llama/llama-4-scout-17b-16e-instruct` | `llama4` | 131K | Llama 4 Scout; newer architecture |
| `groq/llama-3.1-8b-instant` | `llama8` | 128K | Fastest, lightest; good for PM planning |
| `groq/openai/gpt-oss-20b` | `groq` | — | GPT OSS 20B with reasoning |

**Pricing:** Free tier with rate limits. Paid tiers available for high-volume.

---

### Anthropic (`anthropic/…`)
Configured via API key profile. Currently set as fallback for all agents.

| Model ID | Alias | Context | Cost (input/output per 1M) | Notes |
|---|---|---|---|---|
| `anthropic/claude-sonnet-4-20250514` | `claude` | 200K | ~$3 / $15 | Best overall quality; top pick for coder + fixer |
| `anthropic/claude-haiku-4-5` | `haiku` | 200K | ~$0.25 / $1.25 | Fast, cheap; great for PM and QA |
| `anthropic/claude-sonnet-3-5` | — | 200K | ~$3 / $15 | Previous generation; still excellent |

**No free tier.** New accounts get $5 credit. Best quality-per-dollar for complex tasks.

---

### xAI / Grok (`xai/…`)
Configured with your xAI API key.

| Model ID | Alias | Context | Notes |
|---|---|---|---|
| `xai/grok-3` | `grok` | — | Full Grok 3; strong reasoning and coding |
| `xai/grok-3-mini` | `grok-mini` | — | Reasoning model; cheaper than full Grok 3 |
| `xai/grok-3-mini-fast` | `grok-fast` | — | Fastest Grok option; good for PM tasks |

**Pricing:** Pay-per-token. Competitive with GPT-4o pricing.

---

### NVIDIA (`nvidia/…`)
Configured with your NVIDIA API key via `https://integrate.api.nvidia.com/v1`.

| Model ID | Alias | Context | Notes |
|---|---|---|---|
| `nvidia/moonshotai/kimi-k2.5` | `kimi` | 131K | Reasoning model; strong at long-context tasks |

**Pricing:** NVIDIA AI API — free tier available, then pay-per-token.

---

### OpenAI (`openai/…`) ✅ Just added
The standard baseline. Codex is OpenAI's coding-focused reasoning model — purpose-built for agentic tasks like what the swarm does.

| Model ID | Alias | Context | Cost (input/output per 1M) | Notes |
|---|---|---|---|---|
| `openai/codex-mini-latest` | `codex-mini` | 200K | ~$1.50 / $6 | **Recommended for crew-coder** — built for agentic coding |
| `openai/o4-mini` | `o4-mini` | 200K | ~$1.10 / $4.40 | Fast reasoning; great for fixer + security |
| `openai/o3` | `o3` | 200K | ~$10 / $40 | Best reasoning available; use for hard problems only |
| `openai/gpt-4.1` | `gpt-4.1` | 1M | $2 / $8 | Latest GPT; huge context, great instruction following |
| `openai/gpt-4o` | `gpt4o` | 128K | $2.50 / $10 | Reliable all-rounder |
| `openai/gpt-4o-mini` | `gpt4o-mini` | 128K | $0.15 / $0.60 | Best cheap option; great for PM and QA |

---

### DeepSeek (`deepseek/…`) ✅ Just added
Best price-to-quality ratio for coding. V3 matches Claude Sonnet at ~1/10th the cost. R1 is an open-source reasoning model that rivals o1.

| Model ID | Alias | Context | Cost (input/output per 1M) | Notes |
|---|---|---|---|---|
| `deepseek/deepseek-chat` | `deepseek` | 64K | $0.27 / $1.10 | **Best value for coding** — Claude-quality at fraction of cost |
| `deepseek/deepseek-reasoner` | `deepseek-r1` | 64K | $0.55 / $2.19 | R1 reasoning model; rivals o1 on coding benchmarks |
| `deepseek/deepseek-coder` | `deepseek-coder` | 64K | $0.14 / $0.28 | Coding-specialized; cheapest solid option |

---

### Mistral (`mistral/…`) ✅ Just added
European AI lab (French). Strong on instruction following, great European data privacy story. Codestral is their coding-specific model with a 256K context window — one of the longest available for a coding model.

| Model ID | Alias | Context | Cost (in/out per 1M) | Notes |
|---|---|---|---|---|
| `mistral/codestral-latest` | `codestral` | 256K | $0.20 / $0.60 | **Best for coding** — purpose-built, huge context, cheap |
| `mistral/devstral-small-latest` | `devstral` | 131K | ~$0.10 / $0.30 | Agentic coding variant of Codestral; built for tool use |
| `mistral/mistral-large-latest` | `mistral-large` | 131K | $2 / $6 | Best general quality from Mistral |
| `mistral/mistral-medium-latest` | — | 131K | $0.40 / $2 | Mid-tier; good balance |
| `mistral/mistral-small-latest` | `mistral-small` | 131K | $0.10 / $0.30 | Fastest/cheapest; good for PM and QA |

**Standout:** `devstral-small-latest` — specifically trained for agentic software engineering tasks. Uses tools, reads files, writes patches. Worth testing against Codex for the website build.

```bash
OPENCREW_OPENCODE_MODEL=mistral/codestral-latest node pm-loop.mjs
# or agentic variant:
OPENCREW_OPENCODE_MODEL=mistral/devstral-small-latest node pm-loop.mjs
```

---

### Cerebras (`cerebras/…`) ✅ Just added
Cerebras runs on custom silicon (WSE chips) — not GPUs. The result is inference speeds of **1,500–2,100 tokens/sec**, roughly 10–20x faster than Groq for the same Llama models. Same quality, radically faster. Best used for high-volume swarm tasks where speed matters.

| Model ID | Alias | Context | Speed | Cost | Notes |
|---|---|---|---|---|---|
| `cerebras/llama-3.3-70b` | `cerebras-70b` | 128K | ~2,000 tok/s | Free tier | **Fastest 70B available** — same model as your Groq setup |
| `cerebras/llama-3.1-70b` | — | 128K | ~2,000 tok/s | Free tier | Previous gen, similar speed |
| `cerebras/llama-3.1-8b` | `cerebras-8b` | 128K | ~2,100 tok/s | Free tier | Fastest option; great for PM planning |
| `cerebras/qwen-3-32b` | `cerebras-qwen` | 32K | ~1,500 tok/s | Free tier | Qwen 3 — strong reasoning at speed |

**Free tier:** generous limits. Best for: PM task expansion, bulk routing, any task where latency matters.

**To swap from Groq → Cerebras** (same model, much faster):
```bash
OPENCREW_OPENCODE_MODEL=cerebras/llama-3.3-70b node pm-loop.mjs
```

---

### Perplexity (`perplexity/…`) ✅ Just added
Perplexity's Sonar models have **built-in live web search** — every response can pull real-time information. Unique in the lineup: no other provider you have does this natively. Best used for `crew-main` and research-heavy tasks, not raw code generation.

| Model ID | Alias | Context | Cost (input/output per 1M) | Notes |
|---|---|---|---|---|
| `perplexity/sonar-pro` | `sonar-pro` | 200K | $3 / $15 | Best quality + web search; good for crew-main |
| `perplexity/sonar` | `sonar` | 127K | $1 / $1 | Cheaper web-search model |
| `perplexity/sonar-reasoning-pro` | `sonar-reasoning-pro` | 131K | $2 / $8 | Reasoning + web search; good for fixer |
| `perplexity/sonar-reasoning` | — | 127K | $1 / $5 | Lighter reasoning + search |
| `perplexity/sonar-deep-research` | `sonar-research` | 127K | $2 / $8 | Multi-step research tasks; synthesizes many sources |

**Best use in the swarm:** assign `crew-main` to `sonar-pro` so it can web-search while coordinating. Assign `sonar-deep-research` to a dedicated research agent for tasks like "find the best auth library for this stack."

---

### Google Gemini (`google/…`) ✅ Just added
Configured via your Google AI Studio key. Gemini has one of the largest context windows of any provider (up to 2M tokens) and a very generous free tier.

| Model ID | Alias | Context | Cost (input/output per 1M) | Notes |
|---|---|---|---|---|
| `google/gemini-2.5-pro-preview-03-25` | `gemini-pro` | 1M | $1.25 / $10 | Best Gemini; strong reasoning and code |
| `google/gemini-2.0-flash` | `gemini-flash` | 1M | $0.075 / $0.30 | **Free tier** — fast, excellent for most tasks |
| `google/gemini-2.0-flash-lite` | — | 1M | Free | Lightest/fastest option |
| `google/gemini-1.5-pro` | — | **2M** | $1.25 / $5 | Largest context window available anywhere |
| `google/gemini-1.5-flash` | `gemini-flash-1.5` | 1M | Free tier | Reliable, well-tested |

**Free tier:** 15 requests/min, 1M tokens/min — enough to run the full crew for free.

---

### Ollama — Local (`ollama/…`)
**Fully local. No API key. No usage cost. No data leaving your machine.** Configured against `http://127.0.0.1:11434/v1`. Requires [Ollama](https://ollama.ai) running locally.

| Model ID | Alias | Context | Notes |
|---|---|---|---|
| `ollama/qwen2.5:3b-instruct` | `qwen3b` | 128K | Lightweight; runs on CPU; good for simple tasks |

**To add more local models:**
```bash
ollama pull codellama:7b        # Meta's coding-focused Llama
ollama pull qwen2.5-coder:7b   # Qwen coding variant (better than 3b for code)
ollama pull deepseek-coder:6.7b # DeepSeek coder model
ollama pull llama3.1:8b        # General purpose
```

Then add to `~/.crewswarm/crewswarm.json` under `models.providers.ollama.models`:
```json
{ "id": "qwen2.5-coder:7b", "name": "Qwen 2.5 Coder 7B", "contextWindow": 128000 }
```

And use with:
```bash
OPENCREW_OPENCODE_MODEL=ollama/qwen2.5-coder:7b node pm-loop.mjs
```

---

## Full Comparison

| Provider | Model | Quality (coding) | Speed | Cost (in/out per 1M) | Local? | Free tier? | Status |
|---|---|---|---|---|---|---|---|
| OpenCode | `big-pickle` | ⭐⭐⭐⭐⭐ | Fast | Zen sub | No | No | ✅ Wired |
| OpenCode | `gpt-5.2-codex` | ⭐⭐⭐⭐⭐ | Fast | Zen sub | No | No | ✅ Wired |
| Anthropic | `claude-sonnet-4` | ⭐⭐⭐⭐⭐ | Fast | $3 / $15 | No | No | ✅ Wired |
| xAI | `grok-3` | ⭐⭐⭐⭐⭐ | Fast | ~$3 / $15 | No | No | ✅ Wired |
| Anthropic | `claude-sonnet-3-5` | ⭐⭐⭐⭐⭐ | Fast | $3 / $15 | No | No | ✅ Wired |
| Google | `gemini-2.5-pro` | ⭐⭐⭐⭐⭐ | Fast | $1.25 / $10 | No | No | ✅ Just added |
| Google | `gemini-2.0-flash` | ⭐⭐⭐⭐ | Very fast | $0.075 / $0.30 | No | **Yes** | ✅ Just added |
| NVIDIA | `kimi-k2.5` | ⭐⭐⭐⭐ | Medium | Free tier | No | **Yes** | ✅ Wired |
| Cerebras | `llama-3.3-70b` | ⭐⭐⭐⭐ | **Fastest** (~2,000 t/s) | Free tier | No | **Yes** | ✅ Just added |
| Cerebras | `qwen-3-32b` | ⭐⭐⭐⭐ | **Fastest** | Free tier | No | **Yes** | ✅ Just added |
| Groq | `llama-3.3-70b` | ⭐⭐⭐⭐ | Very fast | Free | No | **Yes** | ✅ Wired |
| Groq | `llama-4-scout-17b` | ⭐⭐⭐⭐ | Very fast | Free | No | **Yes** | ✅ Wired |
| xAI | `grok-3-mini` | ⭐⭐⭐⭐ | Fast | ~$0.30 / $0.50 | No | No | ✅ Wired |
| Anthropic | `claude-haiku-4-5` | ⭐⭐⭐ | Very fast | $0.25 / $1.25 | No | No | ✅ Wired |
| Google | `gemini-1.5-pro` | ⭐⭐⭐⭐ | Medium | $1.25 / $5 | No | **Yes** | ✅ Just added |
| Groq | `llama-3.1-8b` | ⭐⭐⭐ | Fastest | Free | No | **Yes** | ✅ Wired |
| OpenCode | `glm-5-free` | ⭐⭐ | Medium | Free | No | **Yes** | ✅ Wired (default) |
| Ollama | `qwen2.5-coder:7b` | ⭐⭐⭐ | Medium* | Free | **Yes** | **Yes** | ✅ Wired |
| Ollama | `codellama:7b` | ⭐⭐⭐ | Medium* | Free | **Yes** | **Yes** | Pull needed |
| Ollama | `llama3.1:8b` | ⭐⭐⭐ | Medium* | Free | **Yes** | **Yes** | Pull needed |
| OpenAI | `codex-mini-latest` | ⭐⭐⭐⭐⭐ | Fast | ~$1.50 / $6 | No | No | ✅ Just added |
| OpenAI | `o4-mini` | ⭐⭐⭐⭐⭐ | Fast | ~$1.10 / $4.40 | No | No | ✅ Just added |
| OpenAI | `o3` | ⭐⭐⭐⭐⭐ | Medium | ~$10 / $40 | No | No | ✅ Just added |
| OpenAI | `gpt-4.1` | ⭐⭐⭐⭐⭐ | Fast | $2 / $8 | No | No | ✅ Just added |
| OpenAI | `gpt-4o` | ⭐⭐⭐⭐⭐ | Fast | $2.50 / $10 | No | No | ✅ Just added |
| OpenAI | `gpt-4o-mini` | ⭐⭐⭐⭐ | Very fast | $0.15 / $0.60 | No | No | ✅ Just added |
| DeepSeek | `deepseek-chat` (V3) | ⭐⭐⭐⭐⭐ | Fast | $0.27 / $1.10 | No | No | ✅ Just added |
| DeepSeek | `deepseek-reasoner` (R1) | ⭐⭐⭐⭐⭐ | Medium | $0.55 / $2.19 | No | No | ✅ Just added |
| Perplexity | `sonar-pro` | ⭐⭐⭐⭐ + 🌐 | Fast | $3 / $15 | No | No | ✅ Just added |
| Perplexity | `sonar-deep-research` | ⭐⭐⭐⭐⭐ 🌐 | Slow | $2 / $8 | No | No | ✅ Just added |
| Together AI | `llama-3.1-405b` | ⭐⭐⭐⭐ | Medium | ~$1 / $1 | No | No | ⚡ Add key |
| Mistral | `codestral-latest` | ⭐⭐⭐⭐ | Fast | $0.20 / $0.60 | No | No | ✅ Just added |
| Mistral | `devstral-small-latest` | ⭐⭐⭐⭐ | Fast | $0.10 / $0.30 | No | No | ✅ Just added |
| Cohere | `command-r-plus` | ⭐⭐⭐⭐ | Fast | $2.50 / $10 | No | No | ⚡ Add key |

*Local model speed depends on your hardware (CPU/GPU/RAM)*

---

## Providers Not Yet Wired (easy to add)

These use the same OpenAI-compatible API format. Add to `~/.crewswarm/crewswarm.json` under `models.providers`:

### OpenAI
```json
"openai": {
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-…",
  "api": "openai-completions",
  "models": [
    { "id": "gpt-4o", "name": "GPT-4o", "contextWindow": 128000 },
    { "id": "gpt-4o-mini", "name": "GPT-4o Mini", "contextWindow": 128000 },
    { "id": "o3-mini", "name": "o3 Mini", "contextWindow": 200000, "reasoning": true }
  ]
}
```

### DeepSeek (best value for coding)
```json
"deepseek": {
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-…",
  "api": "openai-completions",
  "models": [
    { "id": "deepseek-chat", "name": "DeepSeek V3", "contextWindow": 64000 },
    { "id": "deepseek-coder", "name": "DeepSeek Coder", "contextWindow": 64000 },
    { "id": "deepseek-reasoner", "name": "DeepSeek R1", "contextWindow": 64000, "reasoning": true }
  ]
}
```

### Mistral
```json
"mistral": {
  "baseUrl": "https://api.mistral.ai/v1",
  "apiKey": "…",
  "api": "openai-completions",
  "models": [
    { "id": "codestral-latest", "name": "Codestral", "contextWindow": 256000 },
    { "id": "mistral-large-latest", "name": "Mistral Large", "contextWindow": 131000 }
  ]
}
```

### Together AI (cheap 405B)
```json
"together": {
  "baseUrl": "https://api.together.xyz/v1",
  "apiKey": "…",
  "api": "openai-completions",
  "models": [
    { "id": "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", "name": "Llama 3.1 405B", "contextWindow": 130815 }
  ]
}
```

---

## Recommended Configurations

### Codex-powered (best for agentic coding tasks)
```json
{
  "main":     "openai/gpt-4.1",
  "coder":    "openai/codex-mini-latest",
  "pm":       "openai/gpt-4o-mini",
  "qa":       "openai/gpt-4o-mini",
  "fixer":    "openai/o4-mini",
  "security": "openai/o4-mini"
}
```
```bash
OPENCREW_OPENCODE_MODEL=openai/codex-mini-latest node pm-loop.mjs
```

### Best value (DeepSeek does the heavy lifting)
```json
{
  "main":     "openai/gpt-4o-mini",
  "coder":    "deepseek/deepseek-chat",
  "pm":       "groq/llama-3.1-8b-instant",
  "qa":       "deepseek/deepseek-coder",
  "fixer":    "deepseek/deepseek-reasoner",
  "security": "deepseek/deepseek-chat"
}
```
```bash
OPENCREW_OPENCODE_MODEL=deepseek/deepseek-chat node pm-loop.mjs
```

### All-free (Gemini + Groq — zero cost, solid quality)
```json
{
  "main":     "google/gemini-2.0-flash",
  "coder":    "google/gemini-2.0-flash",
  "pm":       "groq/llama-3.1-8b-instant",
  "qa":       "groq/llama-3.3-70b-versatile",
  "fixer":    "google/gemini-2.0-flash",
  "security": "nvidia/moonshotai/kimi-k2.5"
}
```

```bash
OPENCREW_OPENCODE_MODEL=google/gemini-2.0-flash node pm-loop.mjs
```

### Maximum quality (current Zen subscription)
```json
{
  "main":     "opencode/big-pickle",
  "coder":    "opencode/gpt-5.2-codex",
  "pm":       "groq/llama-3.3-70b-versatile",
  "qa":       "anthropic/claude-haiku-4-5",
  "fixer":    "opencode/big-pickle",
  "security": "anthropic/claude-sonnet-4-20250514"
}
```

### Best free setup (no API costs)
```json
{
  "main":     "groq/llama-3.3-70b-versatile",
  "coder":    "groq/llama-3.3-70b-versatile",
  "pm":       "groq/llama-3.1-8b-instant",
  "qa":       "groq/llama-3.3-70b-versatile",
  "fixer":    "groq/llama-3.3-70b-versatile",
  "security": "nvidia/moonshotai/kimi-k2.5"
}
```

### Fully local — no internet, no API keys
```json
{
  "main":     "ollama/llama3.1:8b",
  "coder":    "ollama/qwen2.5-coder:7b",
  "pm":       "ollama/llama3.1:8b",
  "qa":       "ollama/qwen2.5-coder:7b",
  "fixer":    "ollama/codellama:7b",
  "security": "ollama/qwen2.5-coder:7b"
}
```
*Requires Ollama running: `ollama serve`. Quality depends on your machine's RAM/GPU.*

### Mixed — quality where it matters, free everywhere else
```json
{
  "main":     "opencode/big-pickle",
  "coder":    "anthropic/claude-sonnet-4-20250514",
  "pm":       "groq/llama-3.1-8b-instant",
  "qa":       "groq/llama-3.3-70b-versatile",
  "fixer":    "anthropic/claude-sonnet-4-20250514",
  "security": "xai/grok-3"
}
```

---

## Switching models

**Per-agent (in `~/.crewswarm/crewswarm.json`):**
```json
{ "id": "coder", "model": "anthropic/claude-sonnet-4-20250514" }
```

**For PM Loop / OpenCode executor (env var):**
```bash
OPENCREW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514 node pm-loop.mjs
```

**Per-run (dashboard):** Set `OPENCREW_OPENCODE_MODEL` in your shell before starting the dashboard.

**Check what's running:**
```bash
node gateway-bridge.mjs --memory-status   # shows current config
```

---

## Use case cheatsheet

| Task | Best model | Why |
|---|---|---|
| Complex features | `opencode/big-pickle` or `claude-sonnet-4` | Best instruction following |
| Simple CRUD / boilerplate | `groq/llama-3.3-70b-versatile` | Fast + free |
| PM task planning | `groq/llama-3.1-8b-instant` | Speed matters more than quality |
| Bug fixing | `claude-sonnet-4` or `grok-3` | Reasoning models shine here |
| Security audits | `claude-sonnet-4` | Best vulnerability detection |
| Tests / QA | `groq/llama-3.3-70b` or `claude-haiku` | Reliable enough, low cost |
| Long-context analysis | `google/gemini-1.5-pro` | 2M token context — unmatched |
| Large codebases (whole repo in context) | `google/gemini-1.5-pro` | 2M tokens fits most projects entirely |
| Fully offline / private | `ollama/qwen2.5-coder:7b` | Runs entirely locally |
| Parallel bulk tasks | `groq/llama-3.3-70b-versatile` | Rate limits allow parallel calls |
