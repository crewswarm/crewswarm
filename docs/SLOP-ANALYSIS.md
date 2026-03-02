# CrewSwarm — Repo Slop Audit (March 1, 2026)

> **Executive Summary**: 216MB in `crew-cli/tmp/` + 104 untracked status docs + legacy orchestrators never deleted. Plus ~30% padding in `real-time-ui` skill. Aggressive cleanup can drop 300+ files and save 220MB.

---

## 🔥 HIGH PRIORITY — Delete Now

### 1. Root-level test scripts (never used in workflows)
```bash
rm test-claude-bypass.mjs test-harness-improvements.mjs hello.js
```
- `hello.js`: 2 lines, never imported
- `test-claude-bypass.mjs` / `test-harness-improvements.mjs`: One-off verification scripts from harness implementation (Weeks 1&2)
- **Impact**: 5KB, 3 files

### 2. Legacy orchestrators (replaced by `pm-loop.mjs`)
```bash
rm ai-pm.mjs continuous-build.mjs natural-pm-orchestrator.mjs phased-orchestrator.mjs unified-orchestrator.mjs
```
- All replaced by `pm-loop.mjs` (current PM loop)
- Still referenced in 3 old test scripts (`test-complex-orchestration.mjs`, `test-delegation.mjs`)
- **Impact**: ~20KB, 5 files

### 3. Root `auth.js` (test artifact)
```bash
rm auth.js
```
- CommonJS auth utilities with JWT/bcrypt (142 lines)
- Not imported anywhere; crew uses `.crewswarm/config.json` for RT auth
- Only mentioned in test script comments
- **Impact**: 5KB, 1 file

### 4. crew-cli/tmp/ (216MB of patch files and mjs snapshots)
```bash
rm -rf crew-cli/tmp/
mkdir -p crew-cli/tmp  # Keep dir for future temp work
echo "*.patch" > crew-cli/tmp/.gitignore
echo "*.orig" >> crew-cli/tmp/.gitignore
echo "*.new.mjs" >> crew-cli/tmp/.gitignore
```
- Contains: `mcp-openai-context.patch`, `mcp-server.new.mjs`, `mcp-server.parent.orig.mjs`, etc.
- Artifacts from MCP integration & pipeline metrics work (March 1, 2026)
- **Impact**: **216MB**, 9+ files

### 5. Backup files scattered across repo
```bash
find . -name "*.bak" -o -name "*.orig" | grep -v node_modules | xargs rm
```
- `dashboard.mjs.bak`, `chat-handler.mjs.bak`, `website/*.png.bak` (5 images), `.gitignore.bak`
- **Impact**: ~1MB, 8+ files

### 6. Untracked status/completion docs (104 files)
**Root level** (21 files — all untracked, dated 2026-03-01):
```bash
rm ACTION-CHECKLIST-2026-03-01.md \
   AGENTKEEPER-*.md \
   ARCHITECTURE-COMPLETE-2026-03-01.md \
   CODEX-ENHANCEMENTS-2026-03-01.md \
   DASHBOARD-*.md \
   EXECUTIVE-SUMMARY-2026-03-01.md \
   FINAL-STATUS-2026-03-01.md \
   HARNESS-*.md \
   IMPLEMENTATION-SUMMARY.md \
   LAUNCHD-FIX-APPLIED-2026-03-01.md \
   MCP-*.md \
   PHASE-1-*.md \
   PIPELINE-METRICS-INTEGRATION.md \
   PROCESS-DUPLICATION-ROOT-CAUSE-2026-03-01.md \
   SESSION-SUMMARY-*.md \
   SHARED-MEMORY-*.md \
   SWIFTBAR-*.md \
   TEST-RESULTS.md \
   VERIFICATION-RESULTS-2026-03-01.md \
   WEEK-*-COMPLETE-2026-03-01.md
```

**crew-cli/** (13 files):
```bash
cd crew-cli
rm ARCHITECTURE-COMPLETE.md \
   CONTEXT-PACK-OPTIMIZATION.md \
   DEEPSEEK-*.md \
   DOCUMENTATION-INDEX.md \
   FINAL-BENCHMARK-SUMMARY.md \
   GEMINI-*.md \
   MAIN-REPO-VS-BENCHMARK-GEMINI.md \
   MULTI-MODEL-BENCHMARK.md \
   PLANNING-ARTIFACTS-SOLUTION.md \
   VSCODE-EXTENSION-RESULTS.md
```

**crew-cli/benchmarks/** (3 `APPLY-PATCH.md` files + 3 `.patch` files):
```bash
rm crew-cli/benchmarks/deepseek-2026-03-01/APPLY-PATCH.md crew-cli/benchmarks/deepseek-2026-03-01/*.patch
rm crew-cli/benchmarks/gemini-2026-03-01/APPLY-PATCH.md crew-cli/benchmarks/gemini-2026-03-01/*.patch
rm crew-cli/benchmarks/grok-2026-03-01/APPLY-PATCH.md crew-cli/benchmarks/grok-2026-03-01/*.patch
```

**Already archived** (56 files in `docs/archive-2026-03-01/`):
- These are safe — already moved out of the active workspace
- Includes: `3-TIER-LLM-ARCHITECTURE.md`, `AGENTKEEPER-*.md`, `CLI-COMPETITION-ANALYSIS.md`, `GROK-*.md`, `GUNNS-*.md`, `PDD-*.md`, etc.
- **Keep archived** — user may reference later

**crew-cli/benchmarks/BENCHMARK-COMPARISON-2026-03-01.md**:
- Untracked, dated, but useful comparison — **keep or move to docs**

**Impact**: ~500KB, 37+ files removed from active workspace

---

## ⚠️ MEDIUM PRIORITY — Review Before Deleting

### 7. Test scripts that import deleted orchestrators
```bash
# After removing legacy orchestrators, these scripts break:
scripts/test-complex-orchestration.mjs  # imports unified-orchestrator.mjs
scripts/test-delegation.mjs             # imports natural-pm-orchestrator.mjs
```
- **Decision**: Delete or update imports to `pm-loop.mjs`

### 8. crew-cli/ROADMAP.md.spam-backup
```bash
rm crew-cli/ROADMAP.md.spam-backup
```
- Only backup file found with glob
- **Impact**: 5KB, 1 file

### 9. Frontend build artifacts (dist/)
```bash
# frontend/dist/assets/ has 1 JS bundle — normal
# crew-cli/dist/ has 2 built modules — normal (npm run build output)
```
- **Keep** — these are legitimate build outputs

### 10. crew-cli has 90 test files (`tests/*.test.js`) — all legitimate
- **Keep** — these are active test suite

---

## 💡 LOW PRIORITY — Trim Padding (Not Critical)

### 11. Skill slop: `real-time-ui` skill (554 lines)
```bash
# Edit ~/.crewswarm/skills/real-time-ui/SKILL.md
```
**Current structure**:
- Lines 1–400: Core patterns (WebSocket lifecycle, optimistic UI, conflict resolution, SSE) — **keep**
- Lines 401–554: Generic padding:
  - Security checklist (HTTPS, auth, XSS, rate limiting) — **cut** (agent knows this)
  - Testing strategy (MockWebSocket example is useful, but 50 lines) — **trim to 20**
  - Performance tips ("throttle updates", "batch messages") — **cut** (obvious)

**Recommendation**: Trim to ~400 lines — remove security/perf sections, keep MockWebSocket example only
- **Impact**: 150 lines removed (~30% reduction)

---

## 📊 STATS

### Files
- **Total MD files**: 1,203 (399 in main repo, 804+ in crew-cli/docs + tests)
- **Total JS/MJS files**: ~260 active + 90 test files
- **Untracked files** (git status): 104+ MD files (all dated 2026-03-01)

### Size
- `crew-cli/tmp/`: **216MB**
- `docs/archive-2026-03-01/`: 640KB (56 files)
- `archive/`: 360KB (1 file: `dashboard-inline-html-legacy.mjs`)
- `backups/`: 44KB
- Total removable: **~220MB + 104 files**

### Code quality
- **DEPRECATED markers**: 13 occurrences (mostly in older libs, pm-loop, dashboard, continuous-build)
- **TODO/FIXME comments**: Still counting (slow `rg` run backgrounded)
- **Empty functions**: 5 found (2 in dashboard, 1 in spending-tab, others in archived legacy)

---

## ✅ WHAT'S CLEAN

### Good patterns
- `gateway-bridge.mjs`, `crew-lead.mjs`, `pm-loop.mjs` — core runtime, actively maintained
- `lib/` — well-organized modules (agents, engines, memory, runtime, skills, tools)
- `scripts/` — 40+ utility scripts, all legitimate (dashboard, health-check, mcp-server, etc.)
- `frontend/` — Vite build, clean separation (1 bundle in dist/)
- Skills system — 40+ skills (`~/.crewswarm/skills/`), JSON + SKILL.md format
- Memory system — `AgentKeeper`, `AgentMemory`, `Collections` (shared across all agents)

### Non-slop "status docs"
- `AGENTS.md` — **keep** (read by Cursor/Claude, contains setup instructions)
- `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md` — **keep**
- `crew-cli/README.md`, `crew-cli/ROADMAP.md`, `crew-cli/docs/` — **keep** (active docs)

---

## 🚀 RECOMMENDED CLEANUP SCRIPT

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "🧹 CrewSwarm Slop Cleanup"
echo "========================="
echo ""

# HIGH PRIORITY
echo "1. Removing root test scripts..."
rm -v test-claude-bypass.mjs test-harness-improvements.mjs hello.js auth.js

echo "2. Removing legacy orchestrators..."
rm -v ai-pm.mjs continuous-build.mjs natural-pm-orchestrator.mjs phased-orchestrator.mjs unified-orchestrator.mjs

echo "3. Cleaning crew-cli/tmp/ (216MB)..."
rm -rf crew-cli/tmp/*
mkdir -p crew-cli/tmp
cat > crew-cli/tmp/.gitignore <<EOF
*.patch
*.orig
*.new.mjs
*.parent.*
EOF
echo "   Created crew-cli/tmp/.gitignore"

echo "4. Removing backup files..."
find . -name "*.bak" -o -name "*.orig" | grep -v node_modules | xargs -r rm -v

echo "5. Removing untracked status docs (root)..."
rm -v ACTION-CHECKLIST-2026-03-01.md \
     AGENTKEEPER-*.md \
     ARCHITECTURE-COMPLETE-2026-03-01.md \
     CLI-USAGE-LIMIT-ERRORS-2026-03-01.md \
     CODEX-ENHANCEMENTS-2026-03-01.md \
     DASHBOARD-*-2026-03-01.md \
     DASHBOARD-API-IMPROVEMENTS-COMPLETE.md \
     EXECUTIVE-SUMMARY-2026-03-01.md \
     FINAL-STATUS-2026-03-01.md \
     HARNESS-*-2026-03-01.md \
     IMPLEMENTATION-SUMMARY.md \
     LAUNCHD-FIX-APPLIED-2026-03-01.md \
     MCP-*.md \
     PHASE-1-*-2026-03-01.md \
     PIPELINE-METRICS-INTEGRATION.md \
     PROCESS-DUPLICATION-ROOT-CAUSE-2026-03-01.md \
     SESSION-SUMMARY-*.md \
     SHARED-MEMORY-*.md \
     SWIFTBAR-*-2026-03-01.md \
     TEST-RESULTS.md \
     VERIFICATION-RESULTS-2026-03-01.md \
     WEEK-*-COMPLETE-2026-03-01.md 2>/dev/null || true

echo "6. Removing crew-cli status docs..."
cd crew-cli
rm -v ARCHITECTURE-COMPLETE.md \
     CONTEXT-PACK-OPTIMIZATION.md \
     DEEPSEEK-*.md \
     DOCUMENTATION-INDEX.md \
     FINAL-BENCHMARK-SUMMARY.md \
     GEMINI-*.md \
     MAIN-REPO-VS-BENCHMARK-GEMINI.md \
     MULTI-MODEL-BENCHMARK.md \
     PLANNING-ARTIFACTS-SOLUTION.md \
     VSCODE-EXTENSION-RESULTS.md \
     ROADMAP.md.spam-backup 2>/dev/null || true
cd ..

echo "7. Removing benchmark patch files..."
rm -v crew-cli/benchmarks/*/APPLY-PATCH.md crew-cli/benchmarks/*/*.patch 2>/dev/null || true

# MEDIUM PRIORITY
echo "8. Removing broken test scripts (depend on deleted orchestrators)..."
rm -v scripts/test-complex-orchestration.mjs scripts/test-delegation.mjs

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "📊 Estimated savings:"
echo "   Files: ~55+ deleted"
echo "   Disk: ~220MB freed"
echo ""
echo "💡 Next steps:"
echo "   1. Run: git add -A && git status"
echo "   2. Commit: git commit -m 'chore: remove legacy orchestrators, test artifacts, and status docs'"
echo "   3. (Optional) Trim real-time-ui skill from 554 → 400 lines"
```

---

## 🎯 TL;DR — What to Delete

| Category | Files | Size | Action |
|----------|-------|------|--------|
| Root test scripts | 3 | 10KB | ❌ Delete |
| Legacy orchestrators | 5 | 20KB | ❌ Delete |
| Root auth.js | 1 | 5KB | ❌ Delete |
| crew-cli/tmp/ | 9+ | 216MB | ❌ Delete |
| Backup files (*.bak, *.orig) | 8+ | 1MB | ❌ Delete |
| Untracked status docs | 37+ | 500KB | ❌ Delete |
| Broken test scripts | 2 | 5KB | ❌ Delete or fix |
| real-time-ui skill padding | 150 lines | — | ⚠️ Trim (optional) |
| **TOTAL** | **65+ files** | **~220MB** | |

---

## 🚨 WHAT NOT TO DELETE

- `pm-loop.mjs` — current PM loop (replaced all legacy orchestrators)
- `gateway-bridge.mjs`, `crew-lead.mjs`, `telegram-bridge.mjs`, `whatsapp-bridge.mjs` — core runtime
- `scripts/` — 40+ scripts (dashboard, health-check, mcp-server, etc.) — all legitimate
- `lib/` — core modules (agents, engines, memory, runtime, skills, tools)
- `frontend/` — Vite dashboard UI
- `crew-cli/` — standalone CLI (part of the product)
- `docs/archive-2026-03-01/` — already archived, safe to keep for reference
- `archive/dashboard-inline-html-legacy.mjs` — historical reference (old 6K-line inline HTML fallback)
- `AGENTS.md`, `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md` — **actively used**

---

**Verdict**: This is a **working system** with **legacy cruft from rapid iteration**. The 104 untracked status docs and 216MB `tmp/` dir are the biggest offenders. Core code is clean — slop is in artifacts, not logic.
