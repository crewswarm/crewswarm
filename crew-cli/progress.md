# Progress Update

Date: 2026-03-01

## Comprehensive Audit & Security Fixes — 2026-03-01

### P0 - Security & Blocking (ALL DONE)

1. **Fixed parent package.json** - Was incorrectly named `jwt-middleware` with wrong deps/scripts. Now correctly named `crewswarm` with `ws` dep, proper `npm test` (`node --test`), and all scripts (`restart-all`, `dashboard`, `telegram`, `whatsapp`).
   - File: `/Users/jeffhobbs/Desktop/CrewSwarm/package.json`

2. **Added readBody size limit** - `readBody()` in HTTP server now caps at 1MB with 413 response on excess. Prevents memory exhaustion attacks.
   - File: `lib/crew-lead/http-server.mjs:25-35`

3. **Restricted CORS** - All `access-control-allow-origin: *` replaced with `http://127.0.0.1:5173` across 4 locations in HTTP server.
   - File: `lib/crew-lead/http-server.mjs` (lines 21, 131, 248, 945)

4. **Gated --dangerously-skip-permissions** - Claude CLI engine now only uses `--dangerously-skip-permissions` when `CREW_CLAUDE_SKIP_PERMISSIONS=true` is set.
   - File: `crew-cli/src/engines/index.ts:205-210`

5. **Implemented crew_search_code** - Was a stub returning empty results. Now wired to the existing `collections/` TF-IDF search system.
   - File: `crew-cli/src/interface/mcp-handler.ts:273-296`

### P1 - Reliability & UX (ALL DONE)

6. **Added auth to crew-cli server** - `checkAuth()` function validates RT token on POST endpoints (`/v1/chat/completions`, `/tasks`, `/sandbox/*`, `/mcp`). GET endpoints remain open.
   - File: `crew-cli/src/interface/server.ts:81-87, 622, 632, 720, 744`

7. **Added TTL eviction to taskStore** - `createdAt` field added to TaskRecord. Completed/errored tasks evicted after 1 hour. Runs every 10 minutes.
   - File: `crew-cli/src/interface/server.ts:42-53`

8. **Cleaned repo root** - Deleted junk files: `jwt-middleware.js`, `jwt-middleware.test.js`, `jwt-validator.js`, `example-usage.js`, `server.js`, `hello-world.js`, `hello-world.test.js`. Removed empty dirs.

9. **Extracted routing prompt constant** - `ROUTING_SYSTEM_PROMPT` extracted as a shared constant. Used by Grok, DeepSeek, Groq, and Gemini routing methods (was duplicated 4x).
   - File: `crew-cli/src/orchestrator/index.ts:15`

10. **Logger improvements** - Added `export const logger` singleton to `utils/logger.js`. Migrated `engines/index.ts` and `executor/local.ts` from raw `console.log/error` to `logger.warn/error/debug`.
    - Files: `crew-cli/src/utils/logger.js:48`, `crew-cli/src/engines/index.ts`, `crew-cli/src/executor/local.ts`

### P2 - Test & CI (PARTIAL)

14. **GitHub Actions CI** - Created `.github/workflows/ci.yml` with separate jobs for parent repo tests and crew-cli tests (typecheck + test).

15. **TypeScript type checking** - Added `"typecheck": "tsc --noEmit"` script to crew-cli package.json.

### P3 - Code Quality (PARTIAL)

20. **ESLint configured** - Created `eslint.config.js` (flat config, typescript-eslint) with `@typescript-eslint/no-explicit-any: warn`. Added `"lint": "eslint src/"` script.

---

## Remaining Work

### P2 - Test Coverage (NOT STARTED)

- **P2-11: CLI integration tests** - `src/cli/index.ts` (3,824 lines) has zero tests
- **P2-12: REPL tests** - `src/repl/index.ts` (1,720 lines) has zero tests
- **P2-13: executor/local.ts tests** - Core LLM executor untested

### P3 - Code Quality (NOT STARTED)

- **P3-16: Decompose CLI monolith** - Extract from 3,824-line `src/cli/index.ts` into `src/cli/commands/` modules
- **P3-17: Decompose REPL monolith** - Extract from 1,720-line `src/repl/index.ts` into sub-modules
- **P3-18: Decompose dashboard.mjs** - Extract from 3,831-line `scripts/dashboard.mjs` into `scripts/dashboard/` modules
- **P3-19: Replace :any types** - 69 occurrences across 21 files (server.ts has 17)

### Other Known Issues (from audit)

- 571 raw console.log calls bypass Logger (partially fixed in engines + executor)
- 54 process.exit(1) calls in CLI make it untestable
- install.sh prints RT token to stdout (line 86)
- restart-all.sh uses SIGKILL only - should SIGTERM first, then SIGKILL after 5s
- No accessibility on dashboard nav - missing aria labels
- Token counting is chars/4 heuristic in server.ts:490
- Debug writes to hardcoded /tmp/ paths in dual-l2.ts
- Duplicated tokenize/similarity between memory/broker.ts and memory/agentkeeper.ts
