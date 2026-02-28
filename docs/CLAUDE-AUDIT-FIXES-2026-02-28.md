# Claude Code Audit - Fixes Applied (2026-02-28)

## Summary

Claude Code ran a comprehensive 4-hour audit of the CrewSwarm repository and identified several issues. This document tracks what was fixed.

---

## ✅ FIXED - Critical Runtime Bug

### 1. Invalid import in `lib/engines/engine-registry.mjs`

**Issue:** Line 10 had `import os from "os:homedir"` which is invalid Node.js syntax.

**Impact:** Would crash at runtime with module resolution error.

**Fix Applied:**
```diff
- import os from "os:homedir";
+ import os from "node:os";
```

**Status:** ✅ Fixed and verified (no runtime crash in tests)

---

## ✅ FIXED - Repo Cleanup

### 2. Orphaned Python files

**Issue:** `database.py`, `main.py`, `run_migrations.py` were legacy FastAPI/SQLAlchemy files not integrated with the Node.js codebase.

**Fix Applied:** Moved to `/Users/jeffhobbs/Desktop/CrewSwarm-archive/orphaned-files/`

**Status:** ✅ Archived

### 3. Stray HTML test files

**Issue:** `crew-chat.html`, `hobbsistheman.html`, `stinky.html` were test/demo files at repo root.

**Fix Applied:** Moved to `/Users/jeffhobbs/Desktop/CrewSwarm-archive/orphaned-files/`

**Status:** ✅ Archived

### 4. Empty scaffold directories

**Issue:** `/homepage/` (empty) and `/newfeature/` (template skeleton) were unused.

**Fix Applied:** Moved to `/Users/jeffhobbs/Desktop/CrewSwarm-archive/empty-scaffolds/`

**Status:** ✅ Archived

### 5. Archive folder git-ignored

**Issue:** Need to prevent archived files from being accidentally committed back.

**Fix Applied:** Added `../CrewSwarm-archive/` to `.gitignore`

**Status:** ✅ Git-ignored

---

## ⏳ NOT FIXED - Pre-existing Test Issues

### 6. Non-hermetic tests writing to real `~/.crewswarm` paths

**Issue:** Tests in `chat-history.test.mjs`, `spending.test.mjs`, `wave-dispatcher.test.mjs` use real user paths.

**Status:** ⏳ Already tracked in TODO list (test-1, test-2 from previous session)

### 7. PM stop-file path mismatch

**Issue:** Runtime uses repo-local logs, test uses home directory.

**Status:** ⏳ Already tracked in TODO list (test-2 from previous session)

### 8. Engine-routing tests out of sync

**Issue:** Tests in `engine-routing.test.mjs` fail for OpenCode/Codex/Gemini routing.

**Status:** ⏳ Pre-existing (identified by Codex audit in previous session, not yet fixed)

### 9. HTTP integration test uses fixed port instead of random

**Issue:** `http-server.test.mjs` hardcodes port 15099 instead of using `listen(0)`.

**Status:** ⏳ Not fixed yet (low priority)

### 10. TODO in crew-cli tools manager

**Issue:** `crew-cli/src/tools/manager.js` line 13 has unfinished implementation comment.

**Status:** ⏳ Not fixed (crew-cli is separate project, low priority)

---

## Git Status After Fixes

```
M lib/engines/engine-registry.mjs
M .gitignore
```

All archived files were already in `.gitignore`, so cleanup is clean.

---

## Test Results

**Before fix:** Would crash at runtime when `engine-registry.mjs` is imported.

**After fix:** No runtime crash. Same 5 pre-existing test failures:
- PM loop stop detection test
- 4 engine-routing tests (OpenCode, Codex, Gemini)

**Smoke test:** ✅ HTTP server starts, basic routes work

---

## Archive Location

All moved files are safely stored in:

```
/Users/jeffhobbs/Desktop/CrewSwarm-archive/
├── README.md (this file's companion)
├── orphaned-files/
│   ├── database.py
│   ├── main.py
│   ├── run_migrations.py
│   ├── crew-chat.html
│   ├── hobbsistheman.html
│   └── stinky.html
└── empty-scaffolds/
    ├── homepage/
    └── newfeature/
```

Files can be restored by moving them back to `/Users/jeffhobbs/Desktop/CrewSwarm/` if needed.

---

## Next Steps (if desired)

1. Fix pre-existing hermetic test issues (already in TODO list)
2. Fix engine-routing test expectations or update routing logic
3. Update HTTP integration test to use random port
4. Complete crew-cli tools manager implementation
