# Codex CLI Testing Results

## Summary

✅ **Codex works perfectly via dashboard passthrough!**

## What is TTY?

**TTY = TeleTYpewriter** - A terminal interface that allows interactive input/output.

**Why Codex needs TTY:**
- Codex CLI expects to show interactive prompts
- It reads user approval responses from stdin
- Without TTY, it errors: `"stdin is not a terminal"`

**Workaround:**
- Use Codex in `--yolo` mode (auto-approve all actions)
- Route through gateway-bridge/dashboard API (handles TTY requirements)

---

## Testing Results

### ❌ Direct CLI Test (Failed)
```bash
codex "Create hello.txt" --yolo
# Error: stdin is not a terminal
```

### ✅ Gateway Bridge Test (Success)
```bash
curl -X POST http://localhost:4319/api/engine-passthrough \
  -H "Content-Type: application/json" \
  -d '{
    "engine": "codex",
    "message": "Create a simple hello.py file with a hello world function",
    "model": "gpt-4o"
  }'
```

**Output:**
```json
{"type":"chunk","text":"Created hello.py with a simple function"}
{"type":"done","exitCode":0}
```

**File created:**
```python
def hello_world():
    return "Hello, world!"
```

---

## Why `--runtime codex` Didn't Work

When you use `gateway-bridge.mjs --send crew-coder --runtime codex`:

1. Gateway finds `crew-coder` config in `~/.crewswarm/crewswarm.json`
2. **Agent config takes priority** over `--runtime` flag
3. crew-coder config says: `"model": "groq/moonshotai/kimi-k2-instruct-0905"`
4. No `useCodex: true` flag in crew-coder config
5. Result: Uses regular LLM (Kimi via Groq) instead of Codex

**Current crew-coder config:**
```json
{
  "id": "crew-coder",
  "model": "groq/moonshotai/kimi-k2-instruct-0905",
  "useOpenCode": false,
  "opencodeModel": "opencode/big-pickle"
}
```

**Missing field:** `"useCodex": true`

---

## How to Enable Codex for crew-coder

### Option 1: Add to Agent Config (Permanent)
Edit `~/.crewswarm/crewswarm.json`:

```json
{
  "id": "crew-coder",
  "model": "groq/moonshotai/kimi-k2-instruct-0905",
  "useCodex": true,
  "codexModel": "gpt-4o"
}
```

### Option 2: Use Dashboard Passthrough (Temporary)
1. Go to Chat tab
2. Select "🔵 Codex CLI" from engine dropdown
3. Select model from dropdown (o3, gpt-4o, etc.)
4. Send message directly

**This bypasses agent config entirely.**

### Option 3: Create Dedicated Codex Agent
Add new agent to config:

```json
{
  "id": "crew-coder-codex",
  "model": "openai/gpt-4o",
  "useCodex": true,
  "codexModel": "gpt-4o",
  "identity": {
    "name": "Codex Fuller",
    "theme": "Codex-powered Full Stack Coder",
    "emoji": "🔵"
  }
}
```

Then dispatch: `node gateway-bridge.mjs --send crew-coder-codex "task"`

---

## Engine Priority (How CrewSwarm Decides)

```
1. Cursor CLI (if useCursor: true or runtime: cursor)
2. Claude Code (if useClaudeCode: true or runtime: claude)
3. Codex CLI (if useCodex: true or runtime: codex)
4. Docker Sandbox (if useDockerSandbox: true)
5. Gemini CLI (if useGeminiCli: true or runtime: gemini)
6. Generic Engines (from engines/*.json)
7. OpenCode (if useOpenCode: true or runtime: opencode)
8. Regular LLM (fallback - uses agent's model field)
```

**crew-coder currently uses #8** (Regular LLM with Kimi model).

---

## Codex Models Available

From testing and CLI docs:

| Model | Provider | Notes |
|-------|----------|-------|
| **o3** | OpenAI | Latest reasoning model |
| **o1** | OpenAI | Previous reasoning model |
| **gpt-4o** | OpenAI | GPT-4 Optimized ✅ Tested |
| **claude-sonnet-4-5** | Anthropic | Claude via Codex |
| **claude-opus-4** | Anthropic | Claude Opus |
| **gemini-2.0-flash-exp** | Google | Gemini via Codex |

**How to specify:**
```bash
codex -m o3 "task" --yolo
codex -m gpt-4o "task" --yolo
codex -c model="claude-sonnet-4-5" "task" --yolo
```

---

## Codex via Dashboard (Recommended)

**Steps:**
1. Open Dashboard → Chat tab
2. Select **🔵 Codex CLI** from "Engine" dropdown
3. Select model from "Model" dropdown:
   - o3 (best reasoning)
   - gpt-4o (balanced)
   - claude-sonnet-4-5 (via Codex)
4. Type message and send

**Advantages:**
- ✅ No TTY issues
- ✅ Bypasses agent config
- ✅ Live output streaming
- ✅ Model selection UI
- ✅ Session management

---

## Troubleshooting

### "stdin is not a terminal"
**Cause:** Running Codex directly in headless mode.

**Fix:** Use dashboard passthrough or gateway-bridge API.

### "TERM is set to dumb"
**Cause:** No terminal emulation available.

**Fix:** Set `TERM=xterm` or use dashboard passthrough.

### Codex not being used for crew-coder
**Cause:** Agent config missing `useCodex: true`.

**Fix:** Either:
1. Add `"useCodex": true` to crew-coder config
2. Use dashboard passthrough (bypasses agent config)
3. Create separate Codex-specific agent

### Model not found
**Cause:** Invalid model name for Codex.

**Fix:** Use `-m <model>` or `-c model="<model>"` format. Valid models: o3, o1, gpt-4o, claude-sonnet-4-5.

---

## Next Steps

1. ✅ **DONE** - Tested Codex via passthrough API
2. ✅ **DONE** - Verified gpt-4o model works
3. ✅ **DONE** - Updated dashboard model dropdowns
4. ⏳ **TODO** - Add `useCodex` option to Agents tab UI
5. ⏳ **TODO** - Add Codex model selector to agent config editor
6. ⏳ **TODO** - Test other Codex models (o3, claude-sonnet-4-5)

---

## Summary for User

**What we learned:**
- ✅ Codex works perfectly via dashboard passthrough
- ✅ TTY = terminal interface (Codex needs it for interactive prompts)
- ✅ crew-coder doesn't use Codex by default (uses Kimi LLM)
- ✅ `--runtime codex` gets ignored if agent config doesn't have `useCodex: true`

**How to test Codex:**
1. Dashboard → Chat
2. Select "🔵 Codex CLI" 
3. Select model (gpt-4o recommended)
4. Send message

**Want me to:**
1. Add `useCodex: true` to crew-coder config?
2. Create a dedicated Codex agent?
3. Test more Codex models (o3, claude)?
