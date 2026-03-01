# Complete Model List for 3-Tier Stack Configuration

## Summary Table

| Provider | Chat (L1) | Reasoning (L2) | Execution (L3) | Special Features |
|----------|-----------|----------------|----------------|------------------|
| **Grok (x.ai)** | grok-3-mini | grok-4-1-fast-reasoning | grok-3-mini | ✅ X-search, Web search, Vision |
| **Gemini (Google)** | gemini-2.5-flash-lite | gemini-3.1-pro-preview | gemini-2.5-flash-lite | ✅ Free tier, Fast |
| **DeepSeek** | deepseek-chat | deepseek-reasoner | deepseek-chat | ✅ Best reasoning, Cheapest |

---

## 🔷 GEMINI (Google) - Full Model List

### Tier 1: Chat Interface (Fast & Cheap)
| Model | Cost (per 1M tokens) | Speed | Best For |
|-------|---------------------|-------|----------|
| **gemini-2.5-flash-lite** | $0.01 / $0.02 | ⚡⚡⚡⚡⚡ | **RECOMMENDED** - Fastest, cheapest |
| gemini-2.5-flash | $0.075 / $0.30 | ⚡⚡⚡⚡ | Balanced speed/quality |
| gemini-3-flash-preview | $0.075 / $0.30 | ⚡⚡⚡⚡ | Latest features |

### Tier 2: Reasoning/Planning (Smart)
| Model | Cost (per 1M tokens) | Intelligence | Best For |
|-------|---------------------|--------------|----------|
| **gemini-3.1-pro-preview** | $1.25 / $5.00 | ⭐⭐⭐⭐⭐ | **RECOMMENDED** - Latest, best reasoning |
| gemini-2.5-pro | $1.25 / $5.00 | ⭐⭐⭐⭐⭐ | Stable production |

### Tier 3: Execution (Fast & Free)
| Model | Cost (per 1M tokens) | Speed | Best For |
|-------|---------------------|-------|----------|
| **gemini-2.5-flash-lite** | $0.01 / $0.02 | ⚡⚡⚡⚡⚡ | **RECOMMENDED** - Free tier |
| gemini-2.5-flash | $0.075 / $0.30 | ⚡⚡⚡⚡ | More capable |

### Gemini Features:
- ✅ **Free tier** available (flash-lite)
- ✅ Vision support (all models)
- ✅ 128K-1M context window
- ✅ Fast inference
- ❌ No X/Twitter search
- ❌ No built-in web search

---

## 🟣 GROK (x.ai) - Full Model List

### Tier 1: Chat Interface (Fast with Tools)
| Model | Cost (per 1M tokens) | Speed | Best For |
|-------|---------------------|-------|----------|
| **grok-3-mini** | $0.20 / $0.50 | ⚡⚡⚡⚡ | **RECOMMENDED** - Fast, has tools |
| grok-beta | $5.00 / $15.00 | ⚡⚡⚡ | Stable |

### Tier 2: Reasoning/Planning (With Citations)
| Model | Cost (per 1M tokens) | Intelligence | Best For |
|-------|---------------------|--------------|----------|
| **grok-4-1-fast-reasoning** | $0.20 / $0.50 | ⭐⭐⭐⭐⭐ | **RECOMMENDED** - Latest, reasoning tokens |
| grok-4-fast | $0.50 / $2.00 | ⭐⭐⭐⭐ | Fast reasoning |
| grok-beta | $5.00 / $15.00 | ⭐⭐⭐⭐ | Stable |

### Tier 3: Execution (With Tool Access)
| Model | Cost (per 1M tokens) | Speed | Best For |
|-------|---------------------|-------|----------|
| **grok-3-mini** | $0.20 / $0.50 | ⚡⚡⚡⚡ | **RECOMMENDED** - Fast, cheap |
| grok-vision-beta | $10.00 / $30.00 | ⚡⚡⚡ | Vision tasks only |

### Grok UNIQUE Features:
- ✅ **x_search** - Real-time Twitter/X search (**ONLY GROK HAS THIS**)
- ✅ **web_search** - General web search with citations
- ✅ **code_interpreter** - Python sandbox execution
- ✅ **collections_search** - RAG over uploaded docs
- ✅ Vision support (grok-vision-beta)
- ✅ 128K context window
- ✅ Function calling / tool use

---

## 🔵 DEEPSEEK - Full Model List

### Tier 1: Chat Interface (Ultra Cheap)
| Model | Cost (per 1M tokens) | Speed | Best For |
|-------|---------------------|-------|----------|
| **deepseek-chat** | $0.14 / $0.28 | ⚡⚡⚡⚡ | **RECOMMENDED** - Best value |

### Tier 2: Reasoning/Planning (Best Reasoning)
| Model | Cost (per 1M tokens) | Intelligence | Best For |
|-------|---------------------|--------------|----------|
| **deepseek-reasoner** | $0.55 / $2.19 | ⭐⭐⭐⭐⭐ | **RECOMMENDED** - Best reasoning/$, R1 model |

### Tier 3: Execution (Cheapest)
| Model | Cost (per 1M tokens) | Speed | Best For |
|-------|---------------------|-------|----------|
| **deepseek-chat** | $0.14 / $0.28 | ⚡⚡⚡⚡ | **RECOMMENDED** - Cheapest |

### DeepSeek Features:
- ✅ **Best cost/performance ratio**
- ✅ R1 reasoning model (like o1)
- ✅ Excellent code generation
- ❌ No vision
- ❌ No web search
- ❌ No tool calling

---

## 🔴 Other Providers (Reference)

### OpenAI
- **gpt-4o**: $2.50 / $10.00 per 1M tokens
- **gpt-4o-mini**: $0.15 / $0.60 per 1M tokens
- Features: Function calling, vision, good quality

### Anthropic (Claude)
- **claude-3-5-sonnet**: $3.00 / $15.00 per 1M tokens
- **claude-3-5-haiku**: $1.00 / $5.00 per 1M tokens
- Features: Best code quality, large context

### Groq (Fast Inference)
- **llama-3.3-70b-versatile**: $0.59 / $0.79 per 1M tokens
- Features: Ultra-fast (500 tok/s), free tier

---

## Recommended 3-Tier Configurations

### 1. ULTRA-CHEAP (Free/Minimal Cost)
```bash
export CREW_CHAT_MODEL="gemini-2.5-flash-lite"      # FREE
export CREW_REASONING_MODEL="gemini-3.1-pro-preview" # $1.25/$5
export CREW_EXECUTION_MODEL="gemini-2.5-flash-lite"  # FREE
```
**Total cost per complex task**: ~$0.002-0.005

### 2. BEST VALUE (Recommended)
```bash
export CREW_CHAT_MODEL="deepseek-chat"           # $0.14/$0.28
export CREW_REASONING_MODEL="deepseek-reasoner"  # $0.55/$2.19
export CREW_EXECUTION_MODEL="gemini-2.5-flash-lite" # FREE
```
**Total cost per complex task**: ~$0.01-0.02

### 3. MAXIMUM INTELLIGENCE (Research/Social)
```bash
export CREW_CHAT_MODEL="grok-3-mini"                # $0.20/$0.50
export CREW_REASONING_MODEL="grok-4-1-fast-reasoning" # $0.20/$0.50
export CREW_EXECUTION_MODEL="deepseek-chat"         # $0.14/$0.28
```
**Total cost per complex task**: ~$0.015-0.03
**Special**: Has X-search, web-search, code interpreter

### 4. MAXIMUM QUALITY (Production)
```bash
export CREW_CHAT_MODEL="gemini-3.1-pro-preview"     # $1.25/$5.00
export CREW_REASONING_MODEL="deepseek-reasoner"     # $0.55/$2.19
export CREW_EXECUTION_MODEL="claude-3-5-sonnet"     # $3.00/$15.00
```
**Total cost per complex task**: ~$0.08-0.12

### 5. SPEED OPTIMIZED
```bash
export CREW_CHAT_MODEL="groq/llama-3.3-70b"         # $0.59/$0.79 (ultra-fast)
export CREW_REASONING_MODEL="grok-4-1-fast-reasoning" # $0.20/$0.50
export CREW_EXECUTION_MODEL="gemini-2.5-flash-lite"  # FREE
```
**Total cost per complex task**: ~$0.005-0.01

---

## Model Selection Guide

### When to Use Grok Models:
✅ Need real-time X/Twitter data  
✅ Research social trends, sentiment  
✅ Competitive intelligence  
✅ Web search with citations  
✅ Vision + social context

### When to Use Gemini Models:
✅ Want free/ultra-cheap execution  
✅ Fast iteration  
✅ Prototyping  
✅ High volume tasks  
✅ Vision tasks (cheaper than Grok vision)

### When to Use DeepSeek Models:
✅ Need best reasoning per $$$  
✅ Complex planning/logic  
✅ Math/code-heavy tasks  
✅ Cost optimization priority  
✅ R1-style chain-of-thought

### When to Use Other Models:
- **OpenAI**: Best function calling
- **Claude**: Best code quality
- **Groq**: Need ultra-fast inference (500 tok/s)

---

## Cost Comparison (Complex Task Example)

Assuming complex task: 2K input tokens, 5K output tokens, 3 LLM calls (L2 + L3)

| Configuration | L1 Cost | L2 Cost | L3 Cost | Total |
|---------------|---------|---------|---------|-------|
| **Ultra-Cheap** | $0.0000 | $0.0063 | $0.0001 | **$0.0064** |
| **Best Value** | $0.0004 | $0.0120 | $0.0001 | **$0.0125** |
| **Max Intelligence** | $0.0011 | $0.0027 | $0.0009 | **$0.0047** |
| **Max Quality** | $0.0314 | $0.0120 | $0.0755 | **$0.1189** |
| **Speed** | $0.0043 | $0.0027 | $0.0001 | **$0.0071** |

**Winner**: Ultra-Cheap (Gemini) at $0.0064 per complex task

---

## How to Configure

### Method 1: Environment Variables
```bash
# Set in your shell profile (~/.zshrc, ~/.bashrc)
export CREW_USE_UNIFIED_ROUTER="true"
export CREW_DUAL_L2_ENABLED="true"

export CREW_CHAT_MODEL="deepseek-chat"
export CREW_REASONING_MODEL="deepseek-reasoner"
export CREW_EXECUTION_MODEL="gemini-2.5-flash-lite"

# Optional: API keys
export XAI_API_KEY="your-grok-key"
export GEMINI_API_KEY="your-gemini-key"
export DEEPSEEK_API_KEY="your-deepseek-key"
```

### Method 2: Interactive in REPL
```bash
crew repl
crew(manual)> /stack
# Interactive menu to select models
```

### Method 3: Repository Config
Edit `.crew/config.json`:
```json
{
  "models": {
    "chat": "deepseek-chat",
    "reasoning": "deepseek-reasoner",
    "execution": "gemini-2.5-flash-lite"
  }
}
```

---

## Testing Your Configuration

```bash
# Test direct LLMs (baseline)
node scripts/test-direct-llm.mjs

# Test 3-tier pipeline
export CREW_USE_UNIFIED_ROUTER="true"
crew repl --mode builder

# Try a task
crew(builder)> write a JWT validator function
crew(builder)> /trace  # See which models were used

# Check costs
crew(builder)> /info
```

---

## Model Pricing Summary (Quick Reference)

| Model | Input | Output | Per 1M Tokens |
|-------|-------|--------|---------------|
| **gemini-2.5-flash-lite** | $0.01 | $0.02 | ⚡ CHEAPEST |
| **deepseek-chat** | $0.14 | $0.28 | Best value |
| **grok-3-mini** | $0.20 | $0.50 | + X-search |
| **deepseek-reasoner** | $0.55 | $2.19 | Best reasoning |
| **gemini-3.1-pro-preview** | $1.25 | $5.00 | Latest/best |
| **claude-3-5-sonnet** | $3.00 | $15.00 | Best code |
| **grok-beta** | $5.00 | $15.00 | Stable + tools |

---

**Ready to benchmark?** Run `node scripts/test-direct-llm.mjs` with your API keys set!
