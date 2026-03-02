# Chat History Disappearing Bug — Root Cause & Fix

## Problem

User reports: "My old chats keep getting lost - I see the CLI response, but my old chats keep disappearing."

## Root Cause

**Parameter order mismatch** between function signature and call sites.

The `loadHistory` / `appendHistory` / `clearHistory` functions in `lib/chat/history.mjs` expect:

```javascript
function loadHistory(userId = "default", sessionId = "default") { ... }
function appendHistory(userId = "default", sessionId = "default", role, content) { ... }
function clearHistory(userId = "default", sessionId = "default") { ... }
```

But the HTTP server in `lib/crew-lead/http-server.mjs` was calling them with only the `sessionId`:

```javascript
// WRONG — sessionId goes into userId parameter
const history = loadHistory(sessionId);
```

This caused:
- **Writes** go to: `~/.crewswarm/chat-history/default/owner.jsonl` ✓ (via `chat-handler.mjs`, which correctly uses both params)
- **Reads** go to: `~/.crewswarm/chat-history/owner/default.jsonl` ✗ (via HTTP server bug)

Since writes and reads were using different file paths, the dashboard would load an empty history even though messages were being saved correctly.

## Additional Issues Found

The same bug affected multiple call sites:

1. **`lib/crew-lead/http-server.mjs`:**
   - `/history` endpoint (line 259)
   - `/api/crew-lead/history` endpoint (line 237)
   - `/clear` endpoint (line 228)
   - `/chat` endpoint @@RESET handler (line 207)

2. **`crew-lead.mjs`:**
   - Agent completion callbacks (lines 645, 679, 696, 710, 715, 719)
   - PM dispatch callbacks (lines 790, 795, 811, 814, 817, 828)

3. **`lib/crew-lead/background.mjs`:**
   - Background consciousness callback (line 144)

4. **`lib/pipeline/manager.mjs`:**
   - Project confirmation (line 284)
   - Auto-advance callback (line 341)

All of these were calling the functions with incorrect parameter order, causing history to be written/read from wrong locations.

## Files Changed

1. `lib/crew-lead/http-server.mjs` — Fixed 4 endpoints to pass `userId` parameter
2. `crew-lead.mjs` — Fixed 10 `appendHistory` calls to include `userId`
3. `lib/crew-lead/background.mjs` — Fixed 1 `appendHistory` call
4. `lib/pipeline/manager.mjs` — Fixed 2 `appendHistory` calls
5. `scripts/migrate-chat-history.mjs` — **NEW** — Migration script to recover old chats

## Migration Path

### Step 1: Apply the code fixes

All fixes are already applied in this commit. The code now consistently uses:

```javascript
loadHistory("default", sessionId)
appendHistory("default", sessionId, role, content)
clearHistory("default", sessionId)
```

### Step 2: Migrate existing chat files

Many chat history files were written to the wrong locations (root level or wrong subdirectories).

**Preview what will be migrated:**

```bash
node scripts/migrate-chat-history.mjs --dry-run
```

**Perform the migration:**

```bash
node scripts/migrate-chat-history.mjs
```

This script will:
- Move all root-level `.jsonl` files to `default/` directory
- Move misplaced subdirectories (e.g., `owner/system.jsonl`) to `default/`
- **Merge** files that exist in both locations (e.g., old `owner.jsonl` + new `default/owner.jsonl`)
- Sort merged messages by timestamp and deduplicate
- Clean up empty directories

### Step 3: Restart crew-lead

```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm
pkill -f crew-lead.mjs && node crew-lead.mjs &
```

Then refresh the dashboard at http://127.0.0.1:4319 — all your old chats should now be visible!

## Testing

To verify the fix works:

1. Send a message in the dashboard
2. Refresh the page
3. The message should still be visible

Check the file is in the correct location:

```bash
ls -lh ~/.crewswarm/chat-history/default/owner.jsonl
```

## Why This Happened

The codebase underwent a **user isolation refactor** where the history storage format changed from:

```
~/.crewswarm/chat-history/<sessionId>.jsonl
```

To:

```
~/.crewswarm/chat-history/<userId>/<sessionId>.jsonl
```

The `history.mjs` module was updated with the new signature, but not all call sites were updated to match. Some files (like `chat-handler.mjs`) correctly passed both parameters, while others (like `http-server.mjs`) only passed one.

This created a split-brain situation where:
- New messages were written correctly (via `chat-handler.mjs`)
- But reads came back empty (via `http-server.mjs` bug)
- So the dashboard always appeared to have no chat history

## Prevention

To prevent similar issues in the future:

1. **Type checking** — Consider adding JSDoc types or TypeScript to catch parameter mismatches
2. **Integration tests** — The test suite in `test/integration/chat-history.test.mjs` should be expanded to cover the HTTP endpoints
3. **Grep audit** — When refactoring function signatures, always grep for all call sites

## Status

✅ **Fixed** — All code changes applied
⏳ **Migration pending** — User should run migration script to recover old chats
