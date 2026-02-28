# Model Dropdowns - Final Update Summary

## ✅ All Models Updated with ACTUAL CLI Models!

### 1. Cursor CLI Models ✅
**Updated with 40+ models from `cursor agent --list-models`**

**Recommended (No Rate Limits):**
- 🟢 Gemini 3 Flash (fastest)
- 🟢 Gemini 3 Pro
- 🟢 Gemini 3.1 Pro
- 🟢 GPT-5.2 Codex
- 🟢 GPT-5.3 Codex

**Claude Models (May Hit Limits):**
- 🟡 Sonnet 4.5, 4.6
- 🟡 Opus 4.5, 4.6

**Thinking Models:**
- Sonnet/Opus with thinking mode

**Other:**
- Grok, Kimi K2.5

---

### 2. Codex CLI Models ✅
**Updated with ACTUAL models from Codex CLI**

**From `codex` CLI menu:**
1. 🟢 **gpt-5.3-codex** (current) - Latest frontier agentic coding
2. 🟢 **gpt-5.2-codex** - Frontier agentic coding
3. **gpt-5.1-codex-max** - Deep reasoning (slow but thorough)
4. **gpt-5.2** - General purpose frontier model
5. **gpt-5.1-codex-mini** - Fast & cheap

**Old incorrect models removed:** o3, o1, claude, gemini via Codex

---

### 3. Claude Code CLI Models ✅
**Updated with ACTUAL models from Claude CLI**

**From `claude` model selection:**
1. 🟢 **Default** (Sonnet 4.6) - Best for everyday tasks
2. **Opus** (Opus 4.6) - Most capable for complex work
3. **Haiku** (Haiku 4.5) - Fastest for quick answers

**Aliases work:**
- `sonnet`, `opus`, `haiku` (auto-resolve to latest)
- `Default` = Sonnet 4.6 (capitalized as shown in CLI)

**Specific versions:**
- claude-sonnet-4-6
- claude-opus-4-6
- claude-haiku-4-5

---

### 4. Gemini CLI Models ✅
**Already accurate from previous update**

**Recommended:**
- gemini-2.5-flash-latest
- gemini-2.5-pro-latest
- gemini-2.0-flash-exp

**Thinking:**
- gemini-2.0-flash-thinking-exp

---

### 5. OpenCode Models ✅
**Already accurate - OpenRouter format**

- anthropic/claude-sonnet-4-5
- groq/llama-3.3-70b-versatile
- deepseek/deepseek-chat
- openai/gpt-4o
- google/gemini-2.0-flash-exp

---

## Files Updated

1. **frontend/src/app.js** ✅
   - Updated `updatePassthroughModelDropdown()` function
   - All 5 engines now have correct models

2. **frontend/dist/** ✅
   - Rebuilt with `npm run build`
   - New bundle: `index-DpSTt-cm.js` (256.73 KB)

3. **Documentation** ✅
   - `docs/CURSOR-CLI-MODELS.md` - Cursor deep dive
   - `docs/CODEX-MODELS-ACTUAL.md` - Codex models
   - `docs/CLAUDE-CODE-MODELS-ACTUAL.md` - Claude models
   - `docs/DASHBOARD-MODEL-DROPDOWNS.md` - Complete reference

---

## What Changed Per Engine

### Cursor CLI
**Before:** Incorrect models (claude-sonnet-4-5, gpt-5-codex, opus-thinking, grok-4)
**After:** 
- ✅ Actual Gemini models (3-flash, 3-pro, 3.1-pro)
- ✅ Actual Claude models (sonnet-4.5, sonnet-4.6, opus-4.5, opus-4.6)
- ✅ Actual GPT models (gpt-5.2-codex, gpt-5.3-codex variations)
- ✅ Organized into optgroups (Recommended, Claude, Thinking, Other)

### Codex CLI
**Before:** Wrong models (o3, o1, claude-sonnet-4-5, gemini-2.0-flash-exp)
**After:**
- ✅ gpt-5.3-codex (current)
- ✅ gpt-5.2-codex
- ✅ gpt-5.1-codex-max (deep reasoning)
- ✅ gpt-5.2 (general)
- ✅ gpt-5.1-codex-mini (fast/cheap)

### Claude Code
**Before:** Mix of lowercase aliases and specific versions
**After:**
- ✅ Default (Sonnet 4.6) - As shown in CLI
- ✅ Opus (Opus 4.6) - Capitalized alias
- ✅ Haiku (Haiku 4.5) - Capitalized alias
- ✅ Both aliases and specific versions included
- ✅ Descriptions match CLI exactly

---

## How to Use

### Dashboard
1. Open Dashboard → Chat tab
2. Select engine from dropdown:
   - ⚫ Cursor CLI
   - 🟢 Claude Code
   - 🔵 Codex CLI
   - 🔷 Gemini CLI
   - 🟣 OpenCode
3. Model dropdown appears with **CORRECT** models
4. Select model
5. Send message

### Verification
```bash
# Refresh browser to load new bundle
# Check model dropdowns for each engine
# All models should match their CLI's actual output
```

---

## Model Selection Best Practices

### For Speed & Reliability
1. **Cursor → Gemini 3 Flash** (no rate limits, fast)
2. **Codex → gpt-5.1-codex-mini** (fast/cheap)
3. **Claude → Haiku** (fastest)

### For Quality
1. **Cursor → Sonnet 4.5** (best balance)
2. **Codex → gpt-5.1-codex-max** (deep reasoning)
3. **Claude → Opus** (most capable)

### For Balance
1. **Cursor → GPT-5.3 Codex** (reliable)
2. **Codex → gpt-5.3-codex** (current)
3. **Claude → Default (Sonnet 4.6)** (recommended)

---

## Testing Status

| Engine | Model Tested | Works | Notes |
|--------|--------------|-------|-------|
| Cursor | gemini-3-flash | ✅ Yes | Created hello.py |
| Cursor | sonnet-4.5 | ✅ Yes | Created add.mjs |
| Codex | gpt-4o | ✅ Yes | Created hello.py via passthrough |
| Claude | Default | ⏳ Not tested | Need to test with passthrough |
| Gemini | gemini-2.5-flash-latest | ⏳ Not tested | Need to test |

---

## Remaining Issues

### 1. Cursor Passthrough Model Not Sent ⚠️
**Status:** Still investigating
**Workaround:** Use gateway-bridge directly with `--model` flag

### 2. Website Design
**Status:** Ready to update
**Need:** Apply dashboard theme to website

### 3. Animation Issues
**Status:** Need details
**Need:** Which page? Which animation?

---

## Summary for User

**What's Done:**
- ✅ **Cursor models** - All 40+ models from CLI, organized by type
- ✅ **Codex models** - All 5 actual models (5.3-codex, 5.2-codex, 5.1-codex-max, 5.2, 5.1-codex-mini)
- ✅ **Claude models** - Exact aliases from CLI (Default, Opus, Haiku) + specific versions
- ✅ **Gemini models** - Already accurate
- ✅ **OpenCode models** - Already accurate
- ✅ **Frontend rebuilt** - Just refresh browser!
- ✅ **Documentation** - 4 new docs with all model details

**Crew-CLI Bonus:**
- ✅ S3 is optional (uses local storage)
- ✅ Whisper/ElevenLabs already configured in skills
- ✅ Voice mode ready (just add API keys to crewswarm.json)

**Next:**
- ⏳ Fix Cursor passthrough model param
- ⏳ Update website design
- ⏳ Fix animations (need details)

**Just refresh your dashboard and you'll see ALL the correct models!** 🎉
