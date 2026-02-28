# OpenCode (OpenRouter) - Actual Models with Pricing

## Strategy: Free & Cheap Alternative to OAuth CLIs

**Why OpenCode?**
- ✅ **No OAuth** - Pay-as-you-go with API key
- ✅ **Free models** available (Big Pickle, MiniMax, GPT 5 Nano)
- ✅ **Cheap models** for simple tasks
- ✅ **Access to ALL models** via OpenRouter

**When to use:**
- Claude CLI rate limited → Use OpenCode
- Codex too expensive → Use Big Pickle (free)
- Simple tasks → Use free/cheap models

---

## Free Models 🎁

| Model | Input | Output | Best For |
|-------|-------|--------|----------|
| **Big Pickle** | 🆓 Free | 🆓 Free | General coding |
| **MiniMax M2.5 Free** | 🆓 Free | 🆓 Free | Chinese + English |
| **GPT 5 Nano** | 🆓 Free | 🆓 Free | Quick tasks |

**Usage:**
```bash
# Via OpenCode
opencode/big-pickle
opencode/minimax-m2.5-free
openai/gpt-5-nano
```

---

## Budget Models 💰

| Model | Input | Output | Best For |
|-------|-------|--------|----------|
| **GPT 5.1 Codex Mini** | $0.25 | $2.00 | Fast coding |
| **Gemini 3 Flash** | $0.50 | $3.00 | Balanced |
| **Claude Haiku 4.5** | $1.00 | $5.00 | Quick answers |

**Cheapest paid options** for quality work.

---

## Interesting Models 🎯

### Kimi K2.5 ($0.60/$3)
- Chinese company (Moonshot AI)
- 1M token context window
- Good for large codebases

### Kimi K2 Thinking ($0.40/$2.50)
- Reasoning model
- Shows thinking process
- Cheaper than OpenAI o1

### Qwen3 Coder 480B ($0.45/$1.50)
- Alibaba's coding model
- 480 billion parameters
- Excellent for code generation

### GLM 5 ($1/$3.20)
- Zhipu AI (Chinese)
- Strong reasoning
- Good Chinese + English

---

## Premium Models (When You Need Quality)

### Claude Models
| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| Sonnet 4.6 (≤200K) | $3 | $15 | Best for everyday |
| Sonnet 4.6 (>200K) | $6 | $22.50 | Long context |
| Opus 4.6 (≤200K) | $5 | $25 | Most capable |
| Opus 4.6 (>200K) | $10 | $37.50 | Long + capable |
| Haiku 4.5 | $1 | $5 | Fastest |

### OpenAI Codex Models
| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| GPT 5.3 Codex | $1.75 | $14 | Latest |
| GPT 5.2 Codex | $1.75 | $14 | Stable |
| GPT 5.1 Codex Max | $1.25 | $10 | Deep reasoning |
| GPT 5.1 Codex Mini | $0.25 | $2 | Fast/cheap |

### Google Gemini Models
| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| Gemini 3.1 Pro (≤200K) | $2 | $12 | Latest Pro |
| Gemini 3.1 Pro (>200K) | $4 | $18 | Long context |
| Gemini 3 Flash | $0.50 | $3 | Fast |

---

## Model Selection Strategy

### For Simple Tasks
1. **Big Pickle** (Free) - Try first
2. **MiniMax M2.5 Free** (Free) - If Big Pickle fails
3. **GPT 5 Nano** (Free) - Quick fixes

### For Coding Tasks
1. **Qwen3 Coder 480B** ($0.45/$1.50) - Best value for code
2. **GPT 5.1 Codex Mini** ($0.25/$2) - Faster, cheaper
3. **Gemini 3 Flash** ($0.50/$3) - Balanced

### For Complex Reasoning
1. **Kimi K2 Thinking** ($0.40/$2.50) - Cheapest reasoning
2. **GLM 5** ($1/$3.20) - Good quality
3. **GPT 5.1 Codex Max** ($1.25/$10) - Premium

### For Production/Quality
1. **Claude Sonnet 4.6** ($3/$15) - Best for everyday
2. **GPT 5.3 Codex** ($1.75/$14) - Latest OpenAI
3. **Gemini 3.1 Pro** ($2/$12) - Google's best

---

## Cost Comparison: OpenCode vs OAuth CLIs

### Claude Code CLI (OAuth)
- **Cost:** Included in Claude Pro subscription ($20/mo)
- **Rate Limits:** Can hit limits
- **Models:** Sonnet 4.6, Opus 4.6, Haiku 4.5

### Codex CLI (OAuth)
- **Cost:** Included in OpenAI subscription
- **Rate Limits:** Generous
- **Models:** GPT 5.3 Codex, 5.2 Codex, 5.1 Codex Max/Mini

### Cursor CLI (OAuth)
- **Cost:** Included in Cursor subscription
- **Rate Limits:** Can hit limits on Claude models
- **Models:** All major models

### OpenCode (Pay-as-you-go)
- **Cost:** $0 (free models) to $25/M tokens (Opus)
- **Rate Limits:** Based on payment tier
- **Models:** ALL models from all providers

**When OpenCode Wins:**
- ✅ Hit rate limits on OAuth CLIs
- ✅ Need free/cheap models for simple tasks
- ✅ Want access to unique models (Kimi, Qwen, GLM)
- ✅ Pay-per-use more economical than subscription

---

## Dashboard Dropdown Updated

**New OpenCode dropdown:**
```javascript
opencode: [
  { value: '', label: '— default —' },
  { optgroup: 'Free Models 🎁' },
  { value: 'opencode/big-pickle', label: '🆓 Big Pickle (Free)' },
  { value: 'opencode/minimax-m2.5-free', label: '🆓 MiniMax M2.5 Free' },
  { value: 'openai/gpt-5-nano', label: '🆓 GPT 5 Nano (Free)' },
  { optgroup: 'Budget Models 💰' },
  { value: 'openai/gpt-5.1-codex-mini', label: '💰 GPT 5.1 Codex Mini' },
  { value: 'google/gemini-3-flash', label: '💰 Gemini 3 Flash' },
  { value: 'anthropic/claude-haiku-4-5', label: '💰 Claude Haiku 4.5' },
  { optgroup: 'Interesting Models 🎯' },
  { value: 'moonshot/kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'moonshot/kimi-k2-thinking', label: 'Kimi K2 Thinking' },
  { value: 'alibaba/qwen3-coder-480b', label: 'Qwen3 Coder 480B' },
  { value: 'zhipu/glm-5', label: 'GLM 5' },
  { optgroup: 'Premium' },
  // ... Claude, OpenAI, Google premium models
]
```

---

## Which Models to Test?

### Priority 1: Free Models
✅ **Big Pickle** - Most important (free + capable)
✅ **MiniMax M2.5 Free** - Test for quality
✅ **GPT 5 Nano** - Test for speed

### Priority 2: Budget Coding
✅ **Qwen3 Coder 480B** - Specialized for code
✅ **GPT 5.1 Codex Mini** - Cheap OpenAI
✅ **Gemini 3 Flash** - Fast Google

### Priority 3: Interesting/Unique
✅ **Kimi K2 Thinking** - Reasoning at low cost
✅ **Kimi K2.5** - 1M context window
✅ **GLM 5** - Chinese alternative

### Skip: Premium Models
⏩ Claude/OpenAI/Gemini premium - Already available via OAuth CLIs

---

## Testing Plan

### Test Free Models
```bash
# Test Big Pickle
curl -X POST http://localhost:4319/api/engine-passthrough \
  -d '{"engine":"opencode","message":"Create hello.py","model":"opencode/big-pickle"}'

# Test MiniMax
curl -X POST http://localhost:4319/api/engine-passthrough \
  -d '{"engine":"opencode","message":"Create hello.py","model":"opencode/minimax-m2.5-free"}'

# Test GPT 5 Nano
curl -X POST http://localhost:4319/api/engine-passthrough \
  -d '{"engine":"opencode","message":"Create hello.py","model":"openai/gpt-5-nano"}'
```

### Test Budget Coding Models
```bash
# Test Qwen3 Coder
curl -X POST http://localhost:4319/api/engine-passthrough \
  -d '{"engine":"opencode","message":"Create complex function","model":"alibaba/qwen3-coder-480b"}'

# Test Kimi Thinking
curl -X POST http://localhost:4319/api/engine-passthrough \
  -d '{"engine":"opencode","message":"Design system architecture","model":"moonshot/kimi-k2-thinking"}'
```

---

## Provider Format

OpenCode uses `provider/model` format:
- `opencode/big-pickle` - OpenRouter's free model
- `anthropic/claude-sonnet-4-6` - Anthropic via OpenRouter
- `openai/gpt-5.3-codex` - OpenAI via OpenRouter
- `google/gemini-3-flash` - Google via OpenRouter
- `moonshot/kimi-k2.5` - Moonshot AI
- `alibaba/qwen3-coder-480b` - Alibaba Cloud
- `zhipu/glm-5` - Zhipu AI

---

## Summary

**OpenCode's Role:**
- 🎯 **Free alternative** when OAuth CLIs hit limits
- 💰 **Cheap models** for simple/bulk tasks
- 🌏 **Unique models** (Kimi, Qwen, GLM) not available elsewhere
- 📊 **Cost control** - pay per use instead of subscription

**Recommended Flow:**
1. **Try free first:** Big Pickle → MiniMax
2. **Need quality?** Use OAuth CLI (Claude Code, Codex, Cursor)
3. **Hit rate limit?** Fall back to OpenCode
4. **Bulk/simple tasks?** Use OpenCode free models

**Dashboard:** ✅ Updated with free/cheap/interesting models
**Frontend:** ✅ Rebuilt
**Status:** Ready to test free models!
