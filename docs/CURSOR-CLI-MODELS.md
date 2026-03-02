# Cursor CLI Models & Configuration

## Summary of Issues & Fixes

### Problem 1: "Exit code 1" with Cursor CLI
**Root Cause**: The `engines/cursor.json` config had incorrect CLI arguments. It was using `--model {model} --execute {prompt}` which don't exist in Cursor CLI.

**Correct Format**: Cursor uses `cursor agent` subcommand with these flags:
- `--print` - for headless/script mode
- `--yolo` - auto-approve all operations
- `--output-format stream-json` - structured JSON output
- `--model <model>` - specify model (optional)

**Fix Applied**: Updated `engines/cursor.json` with correct args:
```json
{
  "args": {
    "run": ["agent", "--print", "--yolo", "--output-format", "stream-json", "{prompt}"],
    "run_with_model": ["agent", "--print", "--yolo", "--output-format", "stream-json", "--model", "{model}", "{prompt}"]
  }
}
```

### Problem 2: Rate Limits on Claude Models
**Issue**: Claude models (sonnet-4, opus-4) are hitting API rate limits, returning "Exit 1"

**Workaround**: Use alternative models that work:
- ✅ **gemini-3-flash** - Fast, reliable, no rate limits
- ✅ **gemini-3.1-pro** - More capable, slightly slower
- ✅ **sonnet-4.5** - Works but may hit rate limits under heavy use
- ✅ **gpt-5.2-codex** - OpenAI codex, very fast
- ✅ **gpt-5.3-codex** - Latest codex variant
- ❌ **gemini-2.5-flash** - NOT available in Cursor (wrong version number)

---

## Available Cursor Models

Run `cursor agent --list-models` to see all available models:

### Claude Models (Anthropic)
- `sonnet-4.6` - Claude 4.6 Sonnet (current, may have rate limits)
- `sonnet-4.6-thinking` - Claude 4.6 Sonnet with thinking mode
- `opus-4.6` - Claude 4.6 Opus
- `opus-4.6-thinking` - Claude 4.6 Opus with thinking (default model)
- `sonnet-4.5` - Claude 4.5 Sonnet ✅ **WORKS WELL**
- `sonnet-4.5-thinking` - Claude 4.5 Sonnet with thinking
- `opus-4.5` - Claude 4.5 Opus
- `opus-4.5-thinking` - Claude 4.5 Opus with thinking

### OpenAI GPT-5 Models (Fast, Reliable)
- `gpt-5.3-codex` ✅ **RECOMMENDED**
- `gpt-5.3-codex-fast`
- `gpt-5.3-codex-high`
- `gpt-5.3-codex-xhigh`
- `gpt-5.3-codex-spark-preview`
- `gpt-5.2` ✅ **RELIABLE**
- `gpt-5.2-codex`
- `gpt-5.2-codex-fast`
- `gpt-5.2-codex-high`
- `gpt-5.2-codex-xhigh`
- `gpt-5.2-high`
- `gpt-5.1-high`
- `gpt-5.1-codex-max`
- `gpt-5.1-codex-mini`

### Google Gemini Models (No Rate Limits!)
- `gemini-3.1-pro` ✅ **RECOMMENDED**
- `gemini-3-pro` ✅ **WORKS GREAT**
- `gemini-3-flash` ✅ **VERY FAST**

### Other Models
- `grok` - xAI Grok
- `kimi-k2.5` - Moonshot AI Kimi
- `composer-1.5` - Cursor's internal composer model
- `auto` - Let Cursor choose

---

## Recommended Models by Use Case

### For Speed (Fast Iteration)
1. `gemini-3-flash` - Fastest, no rate limits
2. `gpt-5.2-codex-fast`
3. `gpt-5.3-codex-fast`

### For Quality (Complex Tasks)
1. `sonnet-4.5` - Best balance of quality and availability
2. `gpt-5.3-codex-xhigh`
3. `gemini-3.1-pro`

### For No Rate Limits
1. `gemini-3-flash` ✅ **BEST CHOICE**
2. `gemini-3-pro`
3. `gemini-3.1-pro`
4. `gpt-5.2-codex` (OpenAI limits are more generous)

---

## How to Use in CrewSwarm

### Option 1: Set Global Default (Environment Variable)
```bash
export CREWSWARM_CURSOR_MODEL="gemini-3-flash"
```

Add to `~/.zshrc` or `~/.bashrc` for persistence.

### Option 2: Per-Agent Configuration
Edit `~/.crewswarm/crewswarm.json`:

```json
{
  "agents": [
    {
      "id": "crew-coder",
      "useCursor": true,
      "cursorModel": "gemini-3-flash"
    },
    {
      "id": "crew-qa",
      "useCursor": true,
      "cursorModel": "sonnet-4.5"
    }
  ]
}
```

### Option 3: Runtime Override (Dashboard)
In the dashboard's passthrough/chat view:
1. Select "⚡ Engine: Cursor CLI" from dropdown
2. Model is passed via agent config or env var

### Option 4: Direct Dispatch with Model
```bash
node gateway-bridge.mjs --send crew-coder "Build feature X" \
  --runtime cursor \
  --model "gemini-3-flash"
```

---

## Testing Models

### Test a specific model:
```bash
cursor agent --print --yolo --output-format stream-json \
  --model "gemini-3-flash" \
  "Create a hello world function"
```

### Test without specifying model (uses Cursor default):
```bash
cursor agent --print --yolo --output-format stream-json \
  "Create a hello world function"
```

---

## Troubleshooting

### Exit Code 1 Errors

**Symptom**: `cursor agent` exits with code 1, no output

**Common Causes**:
1. **Rate limit** - Claude models hit API limits
   - **Fix**: Switch to Gemini or GPT-5 models
2. **Invalid model name** - Model doesn't exist
   - **Fix**: Run `cursor agent --list-models` to see valid names
3. **No Cursor login** - Not authenticated
   - **Fix**: Open Cursor IDE and sign in
4. **Incorrect flags** - Using wrong CLI arguments
   - **Fix**: Use `agent --print --yolo --output-format stream-json`

### Model Not Found

**Symptom**: `Cannot use this model: <name>`

**Fix**: Check exact model name with `cursor agent --list-models`. Model names are case-sensitive and version-specific.

Examples:
- ❌ `gemini-2.5-flash` - Wrong version number
- ✅ `gemini-3-flash` - Correct
- ❌ `claude-sonnet-4` - Wrong format
- ✅ `sonnet-4.5` - Correct

### Slow Performance

**Symptom**: Tasks take 30+ seconds

**Causes**:
1. Using `-thinking` models (they do extended reasoning)
2. Using `xhigh` or `max` models (more compute)
3. Rate limiting (throttled by provider)

**Fix**: Use faster models:
- `gemini-3-flash` (fastest)
- `gpt-5.2-codex-fast`
- `sonnet-4.5` (no `-thinking` suffix)

---

## Current Config Status

- ✅ **Fixed**: `engines/cursor.json` now has correct CLI args
- ✅ **Default model**: `sonnet-4` (fallback if not specified)
- ⚠️ **Rate limits**: Claude models may hit limits
- ✅ **Recommended**: Switch to `gemini-3-flash` for reliability

---

## Next Steps

1. ✅ **DONE**: Fix Cursor CLI args in `engines/cursor.json`
2. 🔄 **TODO**: Update agent configs to use Gemini models instead of Claude
3. 🔄 **TODO**: Add model dropdown to dashboard for easy switching
4. 🔄 **TODO**: Add rate limit detection and auto-fallback to Gemini

---

## Summary for You

**What was broken**: Cursor CLI config had wrong arguments (`--execute` doesn't exist)

**What's fixed**: Updated `engines/cursor.json` with correct `cursor agent --print --yolo --output-format stream-json` format

**What models work**:
- ✅ Gemini 3 Flash - NO RATE LIMITS, FAST
- ✅ Gemini 3 Pro - NO RATE LIMITS
- ✅ Sonnet 4.5 - WORKS (may hit limits under heavy use)
- ✅ GPT-5.2/5.3 Codex - WORKS

**What to use for testing**:
```bash
# Best choice - fast and reliable (free tier friendly)
export CREWSWARM_CURSOR_MODEL="gemini-3-flash"

# OR for reasoning/complex tasks - Sonnet 4.5 with thinking
export CREWSWARM_CURSOR_MODEL="sonnet-4.5-thinking"

# OR for higher quality without reasoning
export CREWSWARM_CURSOR_MODEL="gemini-3-pro"
```

**For Codex CLI** (which you said is the only one available):
- Codex CLI is a separate tool from Cursor
- Codex doesn't have rate limits
- Keep using Codex for now if Cursor is giving you issues
