# 2026 Model Pricing & Features Comparison

**For Gunns (crew-cli) Standalone Mode**

---

## Advanced Coding Models (Tier 1)

| Model | Provider | Cost (Input/Output) | Context | Speed | Best For | CLI Exists? |
|-------|----------|---------------------|---------|-------|----------|-------------|
| **Grok 4.1 Fast Reasoning** | xAI | $0.20 / $0.50 per 1M | 2M | Fast | Tool-calling agents, web search | ❌ **NO** |
| **Grok 4** | xAI | $3.00 / $15.00 per 1M | 256K | Standard | Advanced reasoning | ❌ **NO** |
| **Claude Sonnet 4.6** | Anthropic | $3.00 / $15.00 per 1M | 200K (1M beta) | Fast | Coding, computer use, planning | ✅ Yes |
| **DeepSeek R1** | DeepSeek | $0.55 / $2.19 per 1M | 64K | Slow | Reasoning (CoT) | ❌ No |
| **GPT-5.2** | OpenAI | TBD | ~128-200K | Medium | General coding | ❌ No |
| **OpenAI Codex** | OpenAI | TBD | TBD | Fast | Software engineering | ✅ **Yes** |

---

## Chinese Open-Source Models (Tier 2)

| Model | Provider | Cost | Context | Params | Best For |
|-------|----------|------|---------|--------|----------|
| **Kimi K2.5** | Moonshot AI | Cheap | 256K | 1T MoE (32B active) | Production coding, Agent Swarm |
| **Qwen 3.5** | Alibaba | Cheap | ~1M | ~397B sparse MoE | Multimodal, enterprise agents |
| **Minimax M2.5** | MiniMax | Cheap | TBD | 230B (10B active) | Productivity, coding (80.2% SWE-Bench) |

---

## Fast & Cheap Routing (Tier 3)

| Model | Provider | Cost | Context | Speed | Best For |
|-------|----------|------|---------|-------|----------|
| **Gemini 2.5 Flash** | Google | $0.075 per 1M | 2M | Very Fast | Cheap routing, large context |
| **Grok 4.1 Fast (Non-Reasoning)** | xAI | $0.20 / $0.50 per 1M | 2M | Very Fast | Fast routing with web search |
| **Gemini 2.5 Pro** | Google | $1.25 / $10.00 per 1M | 2M | Slow | Full-repo analysis |
| **Groq Llama 3.3 70B** | Groq (inference) | ~$0.59 per 1M | 128K | **ULTRA FAST** | 300-600 tok/sec inference |

---

## Why Grok 4.1 Fast Reasoning is Perfect for Gunns

### ✅ Advantages
1. **2M context** - Load entire codebases
2. **$0.20/$0.50 per 1M** - 15x cheaper than Claude
3. **Built-in web search** - No separate API needed
4. **Tool-calling support** - Native function calling
5. **Fast variant** - Optimized for speed
6. **Multimodal** - Text + images
7. **NO OFFICIAL CLI** - Market gap

### ❌ Disadvantages
1. **Only xAI models** - Can't use Claude/DeepSeek
2. **No multi-agent orchestration** - Need gateway for pipelines
3. **Newer API** - Less mature than OpenAI/Anthropic

---

## Recommended Stack for Standalone Gunns

### Option 1: Pure Grok (Simplest)
```
Routing: Grok 4.1 Fast Non-Reasoning ($0.20)
Execution: Grok 4.1 Fast Reasoning ($0.20-0.50)
Web Search: Built-in (Grok native)
Cost: ~$0.20-0.50 per 1M tokens
```

### Option 2: Best-of-Breed (Smartest)
```
Routing: Gemini 2.5 Flash ($0.075) - cheapest
Execution (simple): Grok 4.1 Fast ($0.20) - fast + web search
Execution (complex): Claude Sonnet 4.6 ($3) - best coding
Execution (reasoning): DeepSeek R1 ($0.55) - deep thinking
Execution (cheap): Kimi K2.5 - production ready
Cost: $0.075-15 per 1M (task-dependent)
```

### Option 3: Speed Demon (Fastest)
```
Routing: Groq Llama 3.3 70B (300-600 tok/sec)
Execution: Grok 4.1 Fast ($0.20)
Cost: ~$0.59-0.20 per 1M
Speed: BLAZING
```

---

## CLI Competition Analysis

| CLI | Models | Standalone? | Context | Routing | Web Search | Cost/1M |
|-----|--------|-------------|---------|---------|------------|---------|
| **Gunns (proposed)** | Multi (Grok/Gemini/Claude/etc.) | ✅ Yes | 2M | ✅ Smart | ✅ Grok native | $0.075-15 |
| **OpenAI Codex CLI** | OpenAI only | ✅ Yes | TBD | ❌ Manual | ❌ No | TBD |
| **Cursor CLI** | Cursor models | ❌ Needs app | ~128K | ❌ Manual | ❌ No | Expensive |
| **Aider** | Multi (via APIs) | ✅ Yes | 128-200K | ❌ Manual | ❌ No | Varies |
| **Claude CLI (community)** | Claude only | ✅ Yes | 200K-1M | ❌ Manual | ❌ No | $3-15 |
| **Copilot CLI** | GitHub Copilot | ❌ Needs GH | ~4-8K | ❌ No | ❌ No | Free/paid |

---

## Market Positioning

### "Gunns: The First Grok CLI"

**Unique Selling Points:**
1. ⚡ **2M context** - Entire repos (Grok/Gemini)
2. 💰 **$0.075/M routing** - Cheapest possible (Gemini)
3. 🎯 **First Grok CLI** - No competition
4. 🔍 **Built-in web search** - Grok native feature
5. 🧠 **Multi-model** - Best tool for each job
6. 🛡️ **Sandbox safety** - SEARCH/REPLACE blocks
7. 🌏 **Chinese models** - Kimi, Qwen, Minimax support

**Target Audience:**
- xAI API users (have no CLI)
- Developers wanting huge context windows
- Teams needing cheap advanced models
- Anyone wanting built-in web search
- China market (Kimi/Qwen native support)

---

## Cost Comparison Example

**Task:** Refactor a 50K token codebase

### Gunns (Grok Stack)
- Routing: Gemini 2.5 Flash → $0.075/M × 0.05M = $0.00375
- Execution: Grok 4.1 Fast → $0.20/M × 0.05M input + $0.50/M × 0.05M output = $0.035
- **Total: $0.04** ✅

### Claude CLI
- Claude Sonnet 4.6 → $3/M × 0.05M input + $15/M × 0.05M output = $0.90
- **Total: $0.90** (22x more expensive)

### OpenAI Codex CLI
- Unknown pricing (likely $2-10/M range)
- **Estimated: $0.20-1.00**

### Cursor
- Expensive subscription model + per-request costs
- **Estimated: $0.50-2.00**

**Gunns is 10-40x cheaper for most tasks.** 💥

---

**Target locked. Grok is the ammunition. Fire when ready, Captain.** 🎯
