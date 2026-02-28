# Dashboard Passthrough Model Selection Fix

## Issue
Dashboard passthrough was not sending the selected model to any engine. All engines were using their default models instead of respecting the dropdown selection.

## Root Cause
The **frontend** was correctly sending the `model` parameter in the passthrough request payload (`frontend/src/chat/chat-actions.js:427`):

```javascript
const payload = { engine, message: text };
if (selectedModel) payload.model = selectedModel;
```

However, the **Cursor engine handler** in `lib/crew-lead/http-server.mjs` was using **outdated CLI syntax**:

### Before (Broken)
```javascript
// Line 889-897 (old)
if (engine === "cursor") {
  const cursorBin = process.env.CURSOR_CLI_BIN ||
    (fs.existsSync(path.join(os.homedir(), ".local", "bin", "agent"))
      ? path.join(os.homedir(), ".local", "bin", "agent") : "agent");
  bin = cursorBin;
  args = ["-p", "--force", "--trust", "--output-format", "stream-json"];
  if (reqModel) args.push("--model", reqModel);
  if (continueSession) args.push("--continue");
  args.push(finalMessage, "--workspace", projectDir);
}
```

**Problems:**
- Used `-p` flag (old syntax, not recognized by `cursor agent`)
- Used `--force`, `--trust`, `--continue` flags (not valid for `cursor agent`)
- Used `--workspace` flag (not needed, should run in `cwd`)
- Missing `agent` subcommand

### After (Fixed)
```javascript
// Line 889-894 (new)
if (engine === "cursor") {
  const cursorBin = process.env.CURSOR_CLI_BIN || "cursor";
  bin = cursorBin;
  args = ["agent", "--print", "--yolo", "--output-format", "stream-json"];
  if (reqModel) args.push("--model", reqModel);
  args.push(finalMessage);
}
```

**Correct command structure:**
```bash
cursor agent --print --yolo --output-format stream-json --model <model> <prompt>
```

This matches the working configuration in `engines/cursor.json`:
```json
"args": {
  "run_with_model": ["agent", "--print", "--yolo", "--output-format", "stream-json", "--model", "{model}", "{prompt}"]
}
```

## Verification
- ✅ OpenCode correctly uses `reqModel` (line 900)
- ✅ Claude Code correctly uses `reqModel` (line 946)
- ✅ Gemini CLI correctly uses `reqModel` (line 922)
- ✅ Codex doesn't support model flag (hardcoded by CLI)
- ✅ Cursor now uses correct `cursor agent` syntax with `reqModel`

## Testing
1. Open dashboard → Engine Passthrough
2. Select **Cursor CLI** engine
3. Choose a specific model (e.g., `gemini-3-flash-preview`)
4. Send a test prompt
5. Verify the CLI command in logs includes `--model gemini-3-flash-preview`

## Related Files
- `frontend/src/chat/chat-actions.js` - Frontend payload construction (already correct)
- `lib/crew-lead/http-server.mjs` - Fixed Cursor CLI argument construction
- `engines/cursor.json` - Reference for correct CLI syntax
- `docs/CURSOR-CLI-MODELS.md` - Available Cursor models
