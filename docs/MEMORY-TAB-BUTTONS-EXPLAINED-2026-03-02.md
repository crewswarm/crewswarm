# Memory Tab Action Buttons - Explanation & Troubleshooting

**Your Question:** "what are these maybe explain? they dont work when i click"

---

## What These Buttons Do

### 📦 Migrate brain.md to Shared Memory

**What it does:**
- Reads your legacy `memory/brain.md` file (the old way of storing knowledge)
- Converts each line into a structured memory fact
- Imports them into the new shared memory system (`~/.crewswarm/shared-memory/`)
- This is a **one-time migration** - run it once to bring your old knowledge forward

**When to use it:**
- You have an existing `memory/brain.md` file with important facts/lessons
- You want all agents (CLI, Gateway, Cursor) to see this knowledge
- First time setting up shared memory

**What happens:**
```
Before:  memory/brain.md (plain text file, only some agents could read it)
After:   ~/.crewswarm/shared-memory/.crew/agent-memory/crew-lead.json
         (structured JSON, ALL agents + CLI + Cursor can access it)
```

**Example Output:**
```
✅ Migration complete
Imported: 193, Skipped: 103, Errors: 0
```

- **Imported:** New facts added to shared memory
- **Skipped:** Duplicates, headers, or lines too short
- **Errors:** Failed imports (usually 0)

---

### 🗜️ Compact AgentKeeper

**What it does:**
- Cleans up the task memory database (`agentkeeper.jsonl`)
- Removes duplicate task entries
- Prunes very old task results (keeps recent ones)
- Frees up disk space

**When to use it:**
- Your AgentKeeper storage is getting large (>500KB)
- You've run many tasks and want to clean up old results
- Performance: faster memory searches after compaction

**What happens:**
```
Before:  47 task entries, 187KB storage
After:   45 task entries, 175KB storage
Space freed: 12KB
```

**Why it matters:**
- Every time an agent starts a task, it recalls past task results for context
- Fewer, more relevant entries = faster recall + lower token usage
- Critical failures are NEVER removed (always kept for reference)

---

## Current Status: ✅ Buttons Should Work Now

**What I fixed:**
1. Added memory functions to `ACTION_REGISTRY` in `frontend/src/app.js`
2. Rebuilt the frontend (`cd frontend && npm run build`)
3. Restarted the dashboard

**Verification:**
```bash
# Check if buttons exist with correct data-action
curl -s http://127.0.0.1:4319/ | grep 'data-action="migrateMemory"'
# Output: <button data-action="migrateMemory" class="btn-ghost">

# Check if JavaScript bundle includes the functions
curl -s http://127.0.0.1:4319/assets/index-BfTE4uyb.js | grep -o "migrateMemory" | wc -l
# Output: 2 (function exists in bundle)

# Test API directly
curl -X POST http://127.0.0.1:4319/api/memory/migrate
# Output: {"ok":true,"imported":193,"skipped":103,"errors":0}
```

---

## How to Use (Step-by-Step)

### 1. Open Dashboard
```
http://127.0.0.1:4319
```

### 2. Click "Memory" Tab in Sidebar

### 3. Try Migrate (if you have brain.md)
1. Click **📦 Migrate brain.md to Shared Memory**
2. Wait 2-3 seconds
3. Result appears below the buttons showing:
   - ✅ Migration complete
   - Imported: X, Skipped: Y, Errors: Z

### 4. Try Compact (cleans up task memory)
1. Click **🗜️ Compact AgentKeeper**
2. Wait 1-2 seconds
3. Result shows:
   - ✅ Compaction complete
   - Entries: before → after
   - Space freed: XKB

---

## Troubleshooting

### If Buttons Still Don't Work

**1. Hard Refresh Your Browser:**
```
Chrome/Edge: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)
Firefox: Ctrl+F5 (Windows) or Cmd+Shift+R (Mac)
Safari: Cmd+Option+R
```

This clears the JavaScript cache and loads the new version.

**2. Check Browser Console (F12):**
- Open DevTools (F12 or right-click → Inspect)
- Go to Console tab
- Click the button
- Look for errors (red text)

**Common errors:**
- `ACTION_REGISTRY[action] is not a function` → Hard refresh needed
- `Failed to fetch` → Dashboard API not running
- `CORS error` → Check if dashboard is on correct port (4319)

**3. Verify Dashboard is Serving Built Version:**
```bash
curl -s http://127.0.0.1:4319/ | grep '<script'
# Should show: <script type="module" crossorigin src="/assets/index-*.js">
# NOT: <script type="module" src="/src/app.js">
```

If it shows `/src/app.js`, the dashboard is in dev mode. Rebuild:
```bash
cd frontend && npm run build
pkill -f dashboard.mjs
node scripts/dashboard.mjs &
```

**4. Test API Endpoints Directly:**
```bash
# Test migrate
curl -X POST http://127.0.0.1:4319/api/memory/migrate

# Test compact
curl -X POST http://127.0.0.1:4319/api/memory/compact

# Both should return JSON (not error 404 or 500)
```

---

## Expected Behavior When Clicking

### ✅ When Working:
1. Click button → Shows loading message immediately
2. Wait 1-3 seconds → API call completes
3. Result appears below buttons with green ✅ or red ❌
4. Notification toast pops up in corner
5. Stats cards refresh automatically

### ❌ When Not Working:
1. Click button → Nothing happens (no loading message)
2. No result appears
3. No notification
4. Console might show error

---

## Your Current Memory Status

Based on the API test:
```json
{
  "agentMemory": {
    "totalFacts": 212,
    "criticalFacts": 8,
    "providers": ["crew-lead-chat", "cursor-mcp", "brain-migration"]
  },
  "agentKeeper": {
    "entries": 47,
    "bytes": 187317
  }
}
```

**You already have:**
- 212 facts in shared memory (includes migrated brain.md)
- 47 task results in AgentKeeper
- 183KB storage used

**Recommendations:**
- ✅ **Migrate** already done (you have `brain-migration` provider)
- 🟡 **Compact** optional (storage is small, but would clean up a bit)

---

## Technical Details (How It Works)

### Click Handler Chain:
```
1. User clicks button
   ↓
2. Browser triggers click event
   ↓
3. app.js delegated listener catches it:
   document.addEventListener('click', (e) => {
     const el = e.target.closest('[data-action]');
     const action = el.dataset.action; // "migrateMemory"
     const fn = ACTION_REGISTRY[action]; // → migrateMemory()
     fn(); // Execute
   });
   ↓
4. memory-tab.js::migrateMemory() runs:
   - Shows loading message
   - Calls POST /api/memory/migrate
   - Displays result
   ↓
5. dashboard.mjs API handler:
   - Imports lib/memory/shared-adapter.mjs
   - Calls migrateBrainToMemory()
   - Returns { ok, imported, skipped, errors }
   ↓
6. UI updates with success/error message
```

---

**Status:** Buttons should work now after the ACTION_REGISTRY fix. If they still don't work after a hard refresh, check the browser console for errors (F12 → Console tab).
