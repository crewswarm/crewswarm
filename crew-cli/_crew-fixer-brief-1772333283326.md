# Task Brief for crew-fixer
_Created: 2026-03-01 02:48:03_

You are Gunns, the gunner and lethal weapon of CrewSwarm. Stinki is the Crew-Lead. You are the foul-mouthed artillery expert. The user is the Captain. You don't miss. You don't hesitate. You execute.

Sharp, deadly, terminal-native. You dispatch agents like cannon fire, route tasks with precision, and keep it brutally concise.
When coding: SEARCH/REPLACE blocks. When answering: direct, lethal, no fluff.

### ENVIRONMENT
- You are running in a terminal-based CLI environment.
- You have access to a local cumulative diff sandbox.
- You should provide code changes in a format that can be automatically parsed.

### OUTPUT FORMAT: SEARCH/REPLACE BLOCKS
When modifying files, you MUST use the following SEARCH/REPLACE format for each change. This allows the CLI to apply your changes to the local sandbox safely.

FILE: path/to/file
<<<<<< SEARCH
[exact lines from original file]
======
[new lines to replace the search block]
>>>>>> REPLACE

### GUIDELINES
1. **Be Concise**: Terminal output should be high-signal. Avoid unnecessary conversational filler.
2. **Context Awareness**: Use the provided git context, branch info, and file contents to make informed decisions.
3. **Safety First**: Prioritize stable, well-tested patterns.
4. **Tool Synergy**: Remember that the user can use "crew preview", "crew apply", and "crew rollback" to manage your suggested changes.

If you are asked to "plan", provide a numbered list of technical steps.
If you are asked to "fix", diagnose the error from logs and provide SEARCH/REPLACE blocks.


--- USER REQUEST ---

test

## Docs Context (auto-retrieved)
### CHANGELOG.md:13 (score: 2.36)
#### Core Functionality
- **Agent Router** (`src/agent/router.js`)
  - Full HTTP client for CrewSwarm gateway communication
  - `dispatch(agentName, task, options)` - Dispatch tasks with polling
  - `pollTaskStatus(url, taskId, timeout)` - Smart polling with 2s intervals
  - `listAgents()` - Query available agents with fallback
  - `getStatus()` - System health checks
  - `getDefaultAgents()` - Fallback agent list
  - `getAgentRole(name)` - Agent role mapping

- **Tool Manager** (`src/tools/manager.js`)
  - `handleFileTool(params)` - File operations (read, write, exists)
  - `handleShellTool(params)` - Safe shell command execution

- **Test Suite** (`tests/router.test.js`)
  - 6 comprehensive unit tests
  - Parameter validation tests
  - Error handling tests
  - Fallback behavior tests
  - All tests passing

### CHANGELOG.md:40 (score: 2.36)
#### Scripts & Tools
- `verify.sh` - Automated verification script (17 checks)
- `npm test` - Run all tests
- `npm run check` - Syntax validation
- `npm start` - Run CLI
- `npm run lint` - ESLint

### CHANGELOG.md:59 (score: 2.36)
#### Critical Fixes
- **Router Timeout Issue**
  - Replaced TODO placeholders with full HTTP client implementation
  - Fixed "Timeout waiting for crew-coder" errors
  - Added proper error handling and retries

- **TypeScript Configuration**
  - Fixed module compatibility: `module: "NodeNext"` (was "ESNext")
  - Validated configuration with `tsc --noEmit`
  - All type checks now passing

- **Package Configuration**
  - Fixed test script pattern: `tests/**/*.test.js` (was `tests/`)
  - All npm scripts now functional

- **File Permissions**
  - Made `bin/crew.js` executable (`chmod +x`)

### CHANGELOG.md:83 (score: 2.36)
### 📊 Statistics

- **Files Modified:** 5
- **Files Created:** 9 (4 code + 5 docs)
- **Lines Added:** ~350
- **TODOs Resolved:** 4
- **Tests Added:** 6
- **Test Pass Rate:** 100% (6/6)

### CONTRIBUTING.md:17 (score: 2.36)
## Testing

Before submitting a PR, ensure all tests pass:

```bash
npm test
```

To add tests, create a new file in `tests/` ending with `.test.js` (we use `.js` extension with `tsx` loader to match the runtime). We use the native Node.js test runner (`node:test`).

--- REPO CONTEXT ---

## Repository Context
```text
crew-cli/
├── .crewswarm/
│   └── brain.md
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug.yml
│   │   ├── config.yml
│   │   ├── feature.yml
│   │   └── question.yml
│   └── workflows/
│       ├── crew-ci-fix-example.yml
│       ├── e2e-engines.yml
│       ├── full-audit.yml
│       ├── opencode-comment.yml
│       ├── opencode-pr-review.yml
│       ├── opencode-scheduled.yml
│       ├── opencode-triage.yml
│       ├── publish.yml
│       ├── release-binaries.yml
│       ├── review-strict.yml
│       ├── smoke-test.yml
│       └── soak-test.yml
├── bin/
│   └── crew.js
├── brew/
│   └── crew-cli.rb
├── docs/
│   ├── archive/
│   │   ├── COMPLETION-SUMMARY.md
│   │   ├── FINAL-SUMMARY.md
│   │   ├── FIX-SUMMARY.md
│   │   ├── FIXES.md
│   │   ├── IMPLEMENTATION-NOTES.md
│   │   ├── progress.md
│   │   └── roadmap-status.md
│   ├── marketing/
│   │   ├── blog-post.md
│   │   ├── crew-marketing.html
│   │   ├── hacker-news.md
│   │   ├── product-hunt.md
│   │   ├── sitemap.xml
│   │   ├── social-launch-pack.md
│   │   ├── stinki-avatar.png
│   │   └── stinki-bio.html
│   ├── telegram-miniapp/
│   │   ├── app.js
│   │   ├── index.html
│   │   ├── README.md
│   │   ├── serve.mjs
│   │   └── styles.css
│   ├── API.md
│   ├── CHANGELOG.md
│   ├── CONTRIBUTING.md
│   ├── EXAMPLES.md
│   ├── FEATURES.md
│   ├── github-qa-checklist.md
│   ├── OVERVIEW.md
│   ├── PDD.md
│   ├── project-structure.md
│   ├── qa-9of10-checklist.md
│   ├── QUICKSTART.md
│   ├── RELEASE-CHECKLIST.md
│   ├── ROADMAP.md
│   ├── SECURITY.md
│   ├── STATUS.md
│   ├── telegram-bot-upgrade-spec.md
│   ├── THREE-TIER-IMPLEMENTATION.md
│   └── TROUBLESHOOTING.md
├── examples/
├── installer/
│   └── install.sh
├── lib/
├── src/
│   ├── agent/
│   │   ├── prompt.ts
│   │   └── router.ts
│   ├── auth/
│   │   └── token-finder.ts
│   ├── blast-radius/
│   │   └── index.ts
│   ├── browser/
│   │   └── index.ts
│   ├── cache/
│   │   └── token-cache.ts
│   ├── ci/
│   │   └── index.ts
│   ├── cli/
│   │   └── index.ts
│   ├── collections/
│   │   └── index.ts
│   ├── config/
│   │   └── manager.js
│   ├── context/
│   │   ├── augment.ts
│   │   └── git.ts
│   ├── cost/
│   │   └── predictor.ts
│   ├── diagnostics/
│   │   └── doctor.ts
│   ├── engines/
│   │   └── index.ts
│   ├── headless/
│   │   └── index.ts
│   ├── learning/
│   │   └── corrections.ts
│   ├── lsp/
│   │   └── index.ts
│   ├── mapping/
│   │   └── index.ts
│   ├── mcp/
│   │   └── index.ts
│   ├── memory/
│   │   └── agentkeeper.ts
│   ├── multirepo/
│   │   └── index.ts
│   ├── orchestrator/
│   │   ├── index.ts
│   │   └── worker-pool.ts
│   ├── planner/
│   │   └── index.ts
│   ├── pty/
│   │   └── index.ts
│   ├── repl/
│   │   └── index.ts
│   ├── review/
│   │   └── index.ts
│   ├── safety/
│   ├── sandbox/
│   │   └── index.ts
│   ├── session/
│   │   └── manager.ts
│   ├── sourcegraph/
│   │   └── index.ts
│   ├── strategies/
│   │   └── index.ts
│   ├── team/
│   │   └── index.ts
│   ├── tools/
│   │   └── manager.js
│   ├── utils/
│   │   └── logger.ts
│   ├── voice/
│   │   └── listener.ts
│   ├── watch/
│   │   └── index.ts
│   └── index.ts
├── tests/
│   ├── agentkeeper.test.js
│   ├── blast-radius.test.js
│   ├── browser.test.js
│   ├── ci.test.js
│   ├── code-writing.test.js
│   ├── collections.test.js
│   ├── context-augment.test.js
│   ├── corrections.test.js
│   ├── cost-predictor.test.js
│   ├── doctor.test.js
│   ├── engines.test.js
│   ├── git-context.test.js
│   ├── headless.test.js
│   ├── lsp.test.js
│   ├── mapping.test.js
│   ├── mcp.test.js
│   ├── multirepo.test.js
│   ├── orchestrator.test.js
│   ├── planner-memory.test.js
│   ├── review.test.js
│   ├── router.test.js
│   ├── sandbox.test.js
│   ├── session-manager.test.js
│   ├── sourcegraph.test.js
│   ├── strategies.test.js
│   ├── team.test.js
│   ├── token-cache.test.js
│   ├── voice.test.js
│   ├── watch.test.js
│   └── worker-pool.test.js
├── tools/
│   ├── qa-command-smoke.mjs
│   ├── qa-engine-matrix.mjs
│   ├── qa-file-inventory.mjs
│   ├── qa-gateway-contract.mjs
│   ├── qa-pm-loop-e2e.mjs
│   ├── qa-review-strict.mjs
│   └── qa-soak-headless.mjs
├── .dockerignore
├── .gitignore
├── Dockerfile
├── github.md
├── GUNNS.md
├── IMPLEMENTATION-UPDATE-2026-03-01.md
├── package-lock.json
├── package.json
├── progress.md
├── README.md
├── ROADMAP.md
└── tsconfig.json

```

## Git Context
```text
Branch: main

Status (--short):
M ../.opencode/bun.lock
 M ../.opencode/package.json
 M README.md
 M ROADMAP.md
 M package-lock.json
 M package.json
 M progress.md
 M src/agent/router.ts
 M src/cli/index.ts
 M src/context/augment.ts
 M src/context/git.ts
 M src/cost/predictor.ts
 M src/orchestrator/index.ts
 M src/planner/index.ts
 M src/session/manager.ts
 M src/tools/manager.js
 M src/voice/listener.ts
 D ../frontend/dist/assets/index-BIy-ow5C.js
 M ../frontend/dist/index.html
 M ../frontend/index.html
 M ../frontend/src/app.js
 M ../frontend/src/chat/chat-actions.js
 M ../frontend/src/tabs/settings-tab.js
 M ../lib/crew-lead/chat-handler.mjs
 M ../lib/crew-lead/http-server.mjs
 M ../memory/whatsapp-context.md
 M ../telegram-bridge.mjs
?? ../.crew/
?? ../3-TIER-LLM-ARCHITECTURE.md
?? ../3-TIER-RESEARCH-ANALYSIS.md
?? ../CLI-COMPETITION-ANALYSIS.md
?? ../GUNNS-GROK-ANALYSIS.md
?? ../GUNNS-MODEL-COMPARISON-2026.md
?? ../GUNNS-PERSONALITY.md
?? ../MEMORY-IMPROVEMENTS.md
?? ../SANDBOX-SAFETY.md
?? GUNNS.md
?? IMPLEMENTATION-UPDATE-2026-03-01.md
?? docs/FEATURES.md
?? docs/THREE-TIER-IMPLEMENTATION.md
?? docs/telegram-miniapp/serve.mjs
?? src/agent/prompt.ts
?? src/blast-radius/
?? src/cache/
?? src/collections/
?? src/lsp/
?? src/mapping/
?? src/memory/
?? src/orchestrator/worker-pool.ts
?? src/pty/
?? src/repl/
?? ../docs/TELEGRAM-MINIAPP-DEPLOYMENT.md
?? ../docs/TEST-PROJECT-SWITCHING.md
?? ../frontend/dist/assets/index-Fc2shW0Y.js
?? ../prompt
?? ../scripts/test-project-switching.mjs

Recent commits (last 5):
ab579a5 feat(passthrough): implement true scoped Codex sessions via CODEX_HOME
7f6514d Merge session scope fix from detached HEAD
bea0517 fix(passthrough): add session scope isolation for parallel engine sessions
7604308 fix(engines): make explicit runtime authoritative + expose engineUsed metadata
7a6c13a fix(engines): update runners and opencode lock to match 9/10 release

Unstaged diff:
diff --git a/.opencode/bun.lock b/.opencode/bun.lock
index d158b82..0af9394 100644
--- a/.opencode/bun.lock
+++ b/.opencode/bun.lock
@@ -5,7 +5,7 @@
     "": {
       "name": "opencode-plugins",
       "dependencies": {
-        "@opencode-ai/plugin": "1.2.11",
+        "@opencode-ai/plugin": "1.2.15",
       },
       "devDependencies": {
         "detect-terminal": "2.0.0",
@@ -17,9 +17,9 @@
     },
   },
   "packages": {
-    "@opencode-ai/plugin": ["@opencode-ai/plugin@1.2.11", "", { "dependencies": { "@opencode-ai/sdk": "1.2.11", "zod": "4.1.8" } }, "sha512-84yjouG21IknKXjoygRPy/2Owm2WiEZPwfXDbdYtzzOqFAR8MDj6rz9RU/JqoJMXY/s/0oaEtR5Si3OV5Yo6kg=="],
+    "@opencode-ai/plugin": ["@opencode-ai/plugin@1.2.15", "", { "dependencies": { "@opencode-ai/sdk": "1.2.15", "zod": "4.1.8" } }, "sha512-mh9S05W+CZZmo6q3uIEBubS66QVgiev7fRafX7vemrCfz+3pEIkSwipLjU/sxIewC9yLiDWLqS73DH/iEQzVDw=="],
 
-    "@opencode-ai/sdk": ["@opencode-ai/sdk@1.2.11", "", {}, "sha512-oXSgZCa+66IL9AIWYT8yKZZJOSjEZpLGWue64RD/nWj1EFMHJVPldm4QFQr1nIPd43zl1Bli1mBV2KNuA+bsiA=="],
+    "@opencode-ai/sdk": ["@opencode-ai/sdk@1.2.15", "", {}, "sha512-NUJNlyBCdZ4R0EBLjJziEQOp2XbRPJosaMcTcWSWO5XJPKGUpz0u8ql+5cR8K+v2RJ+hp2NobtNwpjEYfe6BRQ=="],
 
     "detect-terminal": ["detect-terminal@2.0.0", "", {}, "sha512-94Pxgtl45fB4DAfC/dmSNQglU0En4iAmMm5kn8iycZ3lnxWBtWpW622T7WkPEomN9rn7P8LDQbQjPIoyerZW0g=="],
 
diff --git a/.opencode/package.json b/.opencode/package.json
index 0cb0dc8..2e86281 100644
--- a/.opencode/package.json
+++ b/.opencode/package.json
@@ -10,6 +10,6 @@
     "jsonc-parser": "3.3.1"
   },
   "dependencies": {
-    "@opencode-ai/plugin": "1.2.11"
+    "@opencode-ai/plugin": "1.2.15"
   }
 }
\ No newline at end of file
diff --git a/crew-cli/README.md b/crew-cli/README.md
index de8e9c9..879448a 100644
--- a/crew-cli/README.md
+++ b/crew-cli/README.md
@@ -35,6 +35,17 @@ crew apply --check "npm test"
 crew plan "add OAuth login"
 ```
 
+## Intelligence Commands
+
+```bash
+crew docs "how does auth work"       # RAG search over docs/markdown
+crew blast-radius                    # impact analysis of current changes
+crew blast-radius --gate             # CI gate: exit 1 if risk is HIGH
+crew memory "auth login"             # recall prior task memory
+crew memory-compact                  # compact AgentKeeper store
+crew repl                            # interactive multi-agent REPL
+```
+
 ## Advanced Commands
 
 ```bash
@@ -47,14 +58,25 @@ crew repos-scan
 crew doctor
 ```
 
+## Context Flags
+
+`chat` and `dispatch` accept these context injection flags:
+
+- `--docs` — auto-retrieve relevant doc chunks via collections search
+- `--cross-repo` — inject sibling repo context
+- `--context-file <path>` — attach a file
+- `--context-repo <path>` — attach git context from another repo
+- `--stdin` — pipe stdin as context
+
 ## What Is Implemented
 
 - Phase 1 (MVP): complete
 - Phase 2 (Intelligence): complete
 - Phase 3 (Polish/Launch): complete
 - Phase 4 (Advanced): complete
+- Phase 5 (3-Tier LLM Scale-Up): complete
 
-See [ROADMAP.md](docs/ROADMAP.md) and [progress.md](docs/archive/progress.md) for tracked completion.
+See [ROADMAP.md](ROADMAP.md) and [progress.md](progress.md) for tracked completion.
 
 ## Testing
 
@@ -64,10 +86,10 @@ npm run check
 npm test
 ```
 
-Latest local QA pass (2026-02-28):
+Latest local QA pass (2026-03-01):
 - Build: passing
 - Check: passing
-- Tests: 33 passing, 0 failing
+- Tests: 78 passing, 0 failing
 
 ## Documentation
 
diff --git a/crew-cli/ROADMAP.md b/crew-cli/ROADMAP.md
index e2cbe09..1aebf22 100644
--- a/crew-cli/ROADMAP.md
+++ b/crew-cli/ROADMAP.md
@@ -281,6 +281,73 @@
 - [x] CI strict review gate required on PRs (`crew review --strict`) ✓ 2026-02-28
 - [x] Publish `docs/qa-9of10-checklist.md` with release acceptance gates ✓ 2026-02-28
 
+### [x] 9. DevEx Foundations (LSP/PTy/Graph/Image Context) ✓ 2026-03-01
+- [x] Add LSP diagnostics + completions module (`src/lsp/index.ts`) ✓
+- [x] Add CLI commands: `crew lsp check`, `crew lsp complete` ✓
+- [x] Add PTY runtime with `node-pty` + safe fallback (`src/pty/index.ts`) ✓
+- [x] Add CLI command: `crew pty "<command>"` ✓
+- [x] Upgrade repo map to include dependency graph output (`crew map --graph [--json]`) ✓
+- [x] Add image context ingestion (data URI blocks) for `chat` + `dispatch` ✓
+- [x] Add/extend tests:
+  - [x] `tests/lsp.test.js`
+  - [x] `tests/mapping.test.js`
+  - [x] `tests/context-augment.test.js`
+
+---
+
+## Phase 5: 3-Tier LLM Scale-Up (Month 2-3)
+
+Reference design: `docs/THREE-TIER-IMPLEMENTATION.md`
+
+### [x] 1. Parallel Function Calling (Tier 3 workers) ✓ 2026-03-01
+- [x] Introduce worker-executor API in `src/orchestrator/` with bounded concurrency (`maxWorkers`, queue backpressure).
+- [x] Run micro-tasks in parallel and merge to sandbox branches before final apply.
+- [x] Add deterministic merge/conflict policy and failure rollback.
+- [x] Add `crew plan --parallel` execution mode with metrics output.
+- Acceptance criteria:
+  - 10 independent file tasks run concurrently with bounded worker pool.
+  - wall-clock time improves by at least 3x vs sequential baseline.
+  - merge conflicts reported with file-level attribution.
+
+### [x] 2. AgentKeeper Memory (cross-tier persistence) ✓ 2026-03-01
+- [x] Add long-lived task memory store (`.crew/agentkeeper.jsonl` + compacted summary snapshots) (`src/memory/agentkeeper.ts`) ✓
+- [x] Persist Tier 2 planner decisions and Tier 3 worker outputs with run IDs ✓
+- [x] Inject relevant prior plans/results into subsequent runs via memory retrieval (`recallAsContext()`) in `plan`, `dispatch`, and `auto` ✓
+- [x] CLI commands: `crew memory [query]`, `crew memory-compact` ✓
+- [x] Runtime controls: `--no-memory`, `--memory-max <n>` on `plan`, `dispatch`, `auto` ✓
+- Acceptance criteria:
+  - [x] repeated similar tasks reuse prior decomposition patterns (similarity-based recall).
+  - [x] memory compaction keeps store bounded and queryable (`maxEntries` + `compact()`).
+
+### [
... [truncated 396759 chars]

Staged diff:
(none)
```
