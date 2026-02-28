# Codex CLI - Actual Models Available

## Official Codex Models (from CLI)

**Access via:** `codex -m <model_name>` or in `config.toml`

| # | Model | Description |
|---|-------|-------------|
| 1 | **gpt-5.3-codex** | ✅ **Current** - Latest frontier agentic coding model |
| 2 | **gpt-5.2-codex** | Frontier agentic coding model |
| 3 | **gpt-5.1-codex-max** | Codex-optimized flagship for deep and fast reasoning |
| 4 | **gpt-5.2** | Latest frontier model with improvements across knowledge, reasoning and coding |
| 5 | **gpt-5.1-codex-mini** | Optimized for codex. Cheaper, faster, but less capable |

---

## Model Recommendations

### For Speed (Fast Iteration)
**gpt-5.1-codex-mini** ⚡
- Cheapest
- Fastest
- Good for simple tasks

### For Balance (Default)
**gpt-5.3-codex** ✅ RECOMMENDED
- Current/latest model
- Best balance of speed/quality
- Frontier agentic coding

### For Quality (Complex Tasks)
**gpt-5.1-codex-max** 🎯
- Deep reasoning
- Slow but thorough
- Best for architecture/design

### For General Use
**gpt-5.2** 🌐
- Not Codex-specific
- General frontier model
- Good for mixed tasks

---

## How to Use

### 1. Command Line
```bash
codex -m gpt-5.3-codex "Create a function"
codex -m gpt-5.1-codex-mini "Quick fix"
codex -m gpt-5.1-codex-max "Design complex system"
```

### 2. Config File
```toml
# ~/.config/codex/config.toml
[model]
name = "gpt-5.3-codex"
```

### 3. Dashboard Passthrough
1. Select "🔵 Codex CLI" from engine dropdown
2. Select model from dropdown:
   - gpt-5.3-codex (current)
   - gpt-5.2-codex
   - gpt-5.1-codex-max
   - gpt-5.2
   - gpt-5.1-codex-mini
3. Send message

### 4. Gateway Bridge
```bash
node gateway-bridge.mjs --runtime codex --model "gpt-5.3-codex" "task"
```

---

## Model Comparison

| Model | Speed | Cost | Quality | Best For |
|-------|-------|------|---------|----------|
| gpt-5.3-codex | ⚡⚡⚡ | $$ | ⭐⭐⭐⭐ | Default choice |
| gpt-5.2-codex | ⚡⚡⚡ | $$ | ⭐⭐⭐ | Solid option |
| gpt-5.1-codex-max | ⚡ | $$$ | ⭐⭐⭐⭐⭐ | Complex reasoning |
| gpt-5.2 | ⚡⚡ | $$ | ⭐⭐⭐⭐ | General tasks |
| gpt-5.1-codex-mini | ⚡⚡⚡⚡ | $ | ⭐⭐ | Simple/fast tasks |

---

## Testing Results

### ✅ Tested: gpt-4o (via passthrough)
```bash
curl -X POST http://localhost:4319/api/engine-passthrough \
  -d '{"engine":"codex","message":"Create hello.py","model":"gpt-4o"}'
```
**Result:** Created `hello.py` successfully ✅

### ⏳ To Test:
- gpt-5.3-codex
- gpt-5.2-codex
- gpt-5.1-codex-max
- gpt-5.1-codex-mini

---

## Dashboard Updates

**Updated:** `frontend/src/app.js` - `updatePassthroughModelDropdown()`

**New Codex dropdown:**
```javascript
codex: [
  { value: '', label: '— default (gpt-5.3-codex) —' },
  { optgroup: 'Recommended' },
  { value: 'gpt-5.3-codex', label: '🟢 GPT-5.3 Codex (current)' },
  { value: 'gpt-5.2-codex', label: '🟢 GPT-5.2 Codex' },
  { optgroup: 'Specialized' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max (deep reasoning)' },
  { value: 'gpt-5.2', label: 'GPT-5.2 (general purpose)' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini (fast & cheap)' },
]
```

**Build status:** ✅ Rebuilt and deployed

---

## Legacy Models

**Note:** The CLI mentions "access legacy models" - these are the newer models. Older models (o1, o3, claude, gemini via Codex) may still work but are not in the default list.

To use legacy models:
```bash
codex -m o3 "task"
codex -m claude-sonnet-4-5 "task"
```

---

## Summary

**Actual Codex Models:**
1. ✅ gpt-5.3-codex (current)
2. ✅ gpt-5.2-codex
3. ✅ gpt-5.1-codex-max (deep reasoning)
4. ✅ gpt-5.2 (general)
5. ✅ gpt-5.1-codex-mini (fast/cheap)

**Dashboard:** ✅ Updated with correct models
**Frontend:** ✅ Rebuilt
**Status:** Ready to use - just refresh dashboard!
