# CrewSwarm Dashboard Audit — 2026-03-01

## Executive Summary

**Status**: ✅ Dashboard is functional but has several architectural and maintenance concerns

**Key Issues Found**: 9 high-priority, 15 medium-priority, 8 low-priority issues
**Test Coverage**: ⚠️ No automated tests found
**Security Concerns**: 4 items requiring attention

---

## Dashboard Architecture

### Backend (`scripts/dashboard.mjs`)
- **Lines of Code**: 3,830 lines
- **Type**: Node.js HTTP server with manual route handling
- **Pattern**: Single-file monolith with string-based routing
- **Auth**: Basic Auth (hardcoded defaults: `opencode`/`opencode`)

### Frontend
- **Location**: `frontend/` (Vite app)
  - `frontend/index.html` — 1,426 lines of HTML
  - `frontend/src/app.js` — 1,571 lines of JavaScript
  - `frontend/src/styles.css` — CSS
  - `frontend/dist/` — Built output served by backend

---

## Critical Issues 🔴

### 1. **No Route Framework**
- **File**: `scripts/dashboard.mjs`
- **Issue**: Uses manual `if (pathname === ...)` chain instead of Express/Fastify
- **Impact**: Hard to maintain, error-prone, no route documentation
- **Evidence**:
  ```javascript
  if (pathname === "/api/agents") { ... }
  else if (pathname === "/api/send") { ... }
  // Repeated 80+ times
  ```
- **Recommendation**: Migrate to Express or Fastify for maintainability

### 2. **No Input Validation**
- **Files**: All API routes in `dashboard.mjs`
- **Issue**: Request bodies parsed without schema validation
- **Impact**: Security risk, runtime errors, poor error messages
- **Example**:
  ```javascript
  const body = JSON.parse(bodyChunks.join(""));
  // No validation if body.agent exists or is valid
  await sendCrewMessage(body.agent, body.message);
  ```
- **Recommendation**: Add Zod/Joi validation schemas for all endpoints

### 3. **Authentication Weakness**
- **File**: `dashboard.mjs` lines 63-64, 91
- **Issue**: 
  - Default password is `"opencode"` (hardcoded fallback)
  - Password stored in plaintext in env vars
  - No rate limiting on auth failures
- **Evidence**:
  ```javascript
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const pass = process.env.OPENCODE_SERVER_PASSWORD || process.env.SWARM_PASSWORD || "opencode";
  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  ```
- **Recommendation**:
  - Force password change on first run
  - Add bcrypt hashing for stored passwords
  - Implement rate limiting (e.g., `express-rate-limit`)

### 4. **Error Handling Inconsistency**
- **Location**: Throughout `dashboard.mjs` and `app.js`
- **Issue**: 
  - Some routes return 500, some return 200 with `{error: "..."}` **Critical Issue**: This means errors don't properly signal failure to clients
  - No centralized error handler
  - Frontend doesn't consistently check for errors
- **Example from dashboard**:
  ```javascript
  // Some routes do this:
  res.writeHead(500); res.end(JSON.stringify({error: e.message}));
  // Others do this:
  res.end(JSON.stringify({ok: false, error: e.message})); // Returns 200!
  ```
- **Example from frontend**:
  ```javascript
  // Some places check .ok:
  if (r.ok) { ... }
  // Others assume success and just parse data:
  const data = await getJSON('/api/agents');
  ```
- **Recommendation**: Standardize on proper HTTP status codes + centralized error middleware

---

## High-Priority Issues 🟡

### 5. **No Test Coverage**
- **Searched for**: `**/*dashboard*test*`, `**/test*dashboard*`
- **Found**: 0 test files
- **Impact**: No confidence in refactoring, high regression risk
- **Recommendation**: Add integration tests for all API routes using Vitest or Jest

### 6. **Frontend File Size**
- **File**: `frontend/src/app.js`
- **Size**: 1,571 lines, 103 functions
- **Issue**: God object anti-pattern, difficult to navigate/test
- **Recommendation**: Split into modules:
  - `chat/`, `agents/`, `projects/`, `services/`, `settings/`, `skills/`
  - Each tab gets its own folder with component logic

### 7. **Memory Leak Risk in SSE**
- **File**: `dashboard.mjs`, SSE endpoints
- **Issue**: No cleanup on client disconnect, may accumulate listeners
- **Example**: `/api/crew-lead/events` creates event stream but doesn't close on disconnect
- **Recommendation**: Add disconnect handlers to clean up resources

### 8. **Hard-Coded File Paths**
- **File**: `dashboard.mjs` lines 57-89
- **Issue**: Paths to logs, roadmaps, configs are hard-coded
- **Impact**: Breaks when user changes directory structure
- **Example**:
  ```javascript
  const roadmapFile = path.join(OPENCLAW_DIR, "website", "ROADMAP.md");
  ```
- **Recommendation**: Make paths configurable via environment variables

### 9. **No API Documentation**
- **Impact**: Other tools can't integrate, developers can't onboard
- **Recommendation**: Add OpenAPI/Swagger spec or at minimum inline JSDoc comments

---

## Medium-Priority Issues 🟠

### 10. **Inconsistent Response Formats**
- Some endpoints return `{ok: true, data: ...}`, others return bare objects
- **Recommendation**: Standardize on one format (suggest: JSend)

### 11. **No Request Timeout Management**
- Long-running builds/PM loops can hang client indefinitely
- **Recommendation**: Add server-sent progress updates and client-side timeout UI

### 12. **String-Based Agent IDs**
- Agent IDs compared with string equality, no validation
- **Risk**: Typos silently fail (e.g., `"crew-code"` vs `"crew-coder"`)
- **Recommendation**: Add agent ID registry validation

### 13. **Frontend State Management**
- Global variables scattered across `app.js`, no single source of truth
- **Example**: `state.projectsData`, `window._crewLeadInfo`, `window._telemetryEvents`
- **Recommendation**: Use Zustand or Redux for centralized state

### 14. **No Logging Framework**
- Uses `console.log` throughout, hard to filter/search/debug
- **Recommendation**: Add Pino or Winston with structured logging

### 15. **Race Conditions in File Writes**
- Multiple routes write to same config files without locking
- **Example**: Simultaneous saves to `crewswarm.json` can corrupt file
- **Recommendation**: Add file locking or use atomic writes

### 16. **Command Injection Risk**
- `sendCrewMessage()` calls `execSync` with user input
- **File**: `dashboard.mjs` line 142
- **Issue**: Escapes quotes but not other shell metacharacters
- **Recommendation**: Use `spawn` instead of `execSync`, or validate/sanitize input

### 17. **No Rate Limiting**
- API endpoints unprotected, vulnerable to DoS
- **Recommendation**: Add `express-rate-limit` or equivalent

### 18. **Frontend Polling Overhead**
- `refreshAll()` polls every 5 seconds unconditionally
- **File**: `app.js` line 1020
- **Impact**: Unnecessary load when tab inactive
- **Recommendation**: Use Page Visibility API to pause polling when tab hidden

### 19. **No CSRF Protection**
- POST/PUT/DELETE endpoints don't validate CSRF tokens
- **Risk**: Cross-site attacks can modify config
- **Recommendation**: Add CSRF middleware for state-changing operations

### 20. **Large Inline Data**
- Model dropdown lists hard-coded in frontend (400+ lines)
- **File**: `app.js` lines 1397-1507
- **Recommendation**: Move to JSON config file

### 21. **No Backup Before Config Edits**
- Config file overwrites don't keep backups
- **Risk**: User mistake can lose all settings
- **Recommendation**: Create `.bak` file before each save

### 22. **Hardcoded Port References**
- Several places hardcode `localhost:4319`, `localhost:5010`
- **Issue**: Breaks when user changes ports
- **Recommendation**: Read from config/env dynamically

### 23. **No Health Check Endpoint**
- No `/health` or `/api/health` for monitoring tools
- **Recommendation**: Add standardized health endpoint returning service status

### 24. **Git Operations Not Sandboxed**
- Git commands run with user permissions, no chroot/container
- **Risk**: Malicious commands could affect user system
- **Recommendation**: Add safety checks or run in sandboxed environment

---

## Low-Priority Issues 🟢

### 25. **No TypeScript**
- Large JavaScript codebase without type safety
- **Recommendation**: Gradual migration to TypeScript (start with types for API routes)

### 26. **Duplicated DOM Manipulation**
- Similar code patterns repeated (e.g., showing/hiding modals)
- **Recommendation**: Extract to utility functions

### 27. **No Internationalization**
- All text hard-coded in English
- **Recommendation**: Add i18n library if planning multi-language support

### 28. **console.log in Production**
- Debug logs left in production code
- **Recommendation**: Use debug library or remove before release

### 29. **No Analytics/Telemetry**
- No usage tracking for feature adoption
- **Recommendation**: Add optional anonymous telemetry

### 30. **Commented Code**
- Several blocks of commented-out code
- **Recommendation**: Remove dead code or document why it's kept

### 31. **No Dark Mode**
- UI has dark theme but no toggle
- **Recommendation**: Add theme switcher if desired by users

### 32. **No Accessibility Audit**
- No ARIA labels, keyboard navigation may be incomplete
- **Recommendation**: Run axe-core audit and fix issues

---

## Security Audit

### Authentication & Authorization
- ❌ Weak default password (`"opencode"`)
- ❌ No rate limiting on login attempts
- ✅ Uses Basic Auth (but passwords in plain env vars)
- ⚠️ No session expiration

### Input Validation
- ❌ No schema validation on API inputs
- ⚠️ Command injection risk in `execSync` calls
- ❌ No sanitization of file paths
- ⚠️ CSRF tokens not implemented

### Data Protection
- ✅ API keys stored in config files (not in code)
- ❌ Config files world-readable (no chmod 600)
- ⚠️ Logs may contain sensitive data
- ❌ No encryption for sensitive fields in config

### Network Security
- ✅ Binds to 127.0.0.1 by default (localhost only)
- ⚠️ No HTTPS option (plaintext HTTP)
- ❌ No CORS protection configured
- ❌ No Content-Security-Policy headers

---

## Route Inventory

### Dashboard API Routes (HTTP Server)

**Core Dashboard**:
- `GET /` — Serve Vite frontend
- `GET /api/agents` — List agents
- `GET /api/rt-messages` — Recent RT messages
- `GET /api/dlq` — Dead letter queue entries

**Agent Management**:
- `POST /api/send` — Send message to agent
- `POST /api/agents-config` — Update agent config
- `POST /api/agent-reset` — Reset agent session
- `POST /api/agent-routes` — Update agent routing

**Projects & Build**:
- `GET /api/projects` — List projects
- `POST /api/projects` — Create project
- `PATCH /api/projects/:id` — Update project
- `DELETE /api/projects/:id` — Delete project
- `POST /api/build` — Start build
- `POST /api/stop-build` — Stop build

**Skills**:
- `GET /api/skills` — List skills
- `POST /api/skills` — Create skill
- `DELETE /api/skills/:name` — Delete skill
- `POST /api/skills/:name/run` — Run skill

**PM Loop**:
- `GET /api/pm-status` — PM loop status
- `POST /api/pm-start` — Start PM loop
- `POST /api/pm-stop` — Stop PM loop

**Services**:
- `GET /api/services` — Service status
- `POST /api/service/:id/restart` — Restart service
- `POST /api/service/:id/stop` — Stop service

**Config & Settings**:
- `GET /api/config` — Get config
- `POST /api/config` — Update config
- `GET /api/env` — Get environment vars
- `POST /api/cmd-allowlist` — Manage command allowlist

**Telegram & WhatsApp**:
- `GET /api/telegram/status` — Telegram bridge status
- `POST /api/telegram/start` — Start Telegram bridge
- `POST /api/telegram/stop` — Stop Telegram bridge
- `GET /api/whatsapp/status` — WhatsApp bridge status
- `POST /api/whatsapp/start` — Start WhatsApp bridge

**Memory**:
- `GET /api/memory/stats` — Memory stats
- `POST /api/memory/search` — Search memory
- `POST /api/memory/migrate` — Migrate brain.md
- `POST /api/memory/compact` — Compact AgentKeeper

**Benchmarks**:
- `GET /api/benchmarks` — List benchmarks
- `GET /api/benchmarks/:id` — Benchmark leaderboard
- `POST /api/benchmark/run` — Run benchmark task

**Crew Lead**:
- `GET /api/crew-lead/events` — SSE event stream
- `POST /api/crew-lead/chat` — Chat with crew-lead
- `POST /api/crew-lead/confirm-project` — Confirm project draft

**Total**: 50+ routes (estimated)

### Missing Routes / Gaps
1. No `/api/health` health check endpoint
2. No `/api/version` or `/api/info`
3. No pagination params for list endpoints
4. No bulk operations (e.g., `POST /api/agents/bulk-update`)
5. No undo/rollback for config changes
6. No export/import for full config backup

---

## Performance Concerns

### Backend
- ✅ Uses async/await properly
- ⚠️ Synchronous file reads in some hot paths
- ⚠️ No caching for expensive operations (e.g., agent list)
- ❌ No connection pooling for external API calls
- ⚠️ Heartbeat refresh runs every 30s (could be optimized)

### Frontend
- ❌ Loads 1.5k lines of JS in single `app.js` bundle
- ⚠️ Polls every 5s even when tab inactive
- ⚠️ Re-renders large lists without virtualization
- ⚠️ No debouncing on search inputs
- ✅ Uses `data-action` delegation (good for memory)

---

## Code Quality Metrics

**Backend (`dashboard.mjs`)**:
- Lines: 3,830
- Functions: ~120 (estimated)
- Max function length: ~150 lines
- Cyclomatic complexity: High (many nested conditions)
- Documentation: Minimal inline comments

**Frontend (`app.js`)**:
- Lines: 1,571
- Functions: 103
- Max function length: ~80 lines
- Global variables: 15+
- Documentation: Sparse

**HTML (`index.html`)**:
- Lines: 1,426
- Inline styles: Frequent
- Accessibility: Not audited

---

## Recommendations by Priority

### Immediate (Do Now)
1. ✅ **Fix weak default password** — Force user to set password on first run
2. ✅ **Add input validation** — Use Zod schemas for all API inputs
3. ✅ **Standardize error responses** — Use proper HTTP status codes
4. ✅ **Add command injection protection** — Replace `execSync` with `spawn`

### Short-term (This Sprint)
5. ✅ **Add integration tests** — At least smoke tests for critical routes
6. ✅ **Split frontend into modules** — Extract tab logic into separate files
7. ✅ **Add health check endpoint** — `/api/health` for monitoring
8. ✅ **Implement CSRF protection** — Add tokens for state-changing operations
9. ✅ **Add rate limiting** — Protect against brute force and DoS

### Medium-term (Next Quarter)
10. ✅ **Migrate to Express** — Replace manual routing
11. ✅ **Add API documentation** — OpenAPI spec or interactive docs
12. ✅ **Implement file locking** — Prevent config corruption
13. ✅ **Add backup mechanism** — Auto-backup configs before edits
14. ✅ **Improve logging** — Structured logs with log levels

### Long-term (Backlog)
15. ✅ **TypeScript migration** — Start with API layer
16. ✅ **Add telemetry** — Optional usage analytics
17. ✅ **Accessibility audit** — WCAG 2.1 AA compliance
18. ✅ **i18n support** — If multi-language needed

---

## Test Plan (Recommended)

### Unit Tests
- ✅ Route handlers (mock file system)
- ✅ Utility functions (path resolution, JSON parsing)
- ✅ Frontend components (if refactored to modules)

### Integration Tests
- ✅ API endpoints with real file system
- ✅ SSE streams
- ✅ Multi-step workflows (create project → build)

### E2E Tests
- ✅ Login flow
- ✅ Agent configuration workflow
- ✅ Build + PM loop end-to-end
- ✅ Error recovery scenarios

### Security Tests
- ✅ SQL injection attempts (if DB added)
- ✅ Command injection via malicious input
- ✅ CSRF attacks
- ✅ Rate limiting enforcement

---

## Architecture Improvements

### Proposed Refactor

**Backend** (dashboard.mjs → modular):
```
scripts/dashboard/
├── server.mjs          # HTTP server setup
├── auth.mjs            # Authentication middleware
├── routes/
│   ├── agents.mjs
│   ├── projects.mjs
│   ├── skills.mjs
│   ├── memory.mjs
│   └── config.mjs
├── services/
│   ├── agent-service.mjs
│   ├── project-service.mjs
│   └── file-service.mjs
└── utils/
    ├── validation.mjs
    ├── error-handler.mjs
    └── logger.mjs
```

**Frontend** (app.js → modular):
```
frontend/src/
├── app.js              # Entry point
├── core/
│   ├── api.js          # Centralized API client
│   ├── state.js        # Global state management
│   └── router.js       # Client-side routing
├── tabs/
│   ├── agents-tab/
│   │   ├── index.js
│   │   ├── agent-card.js
│   │   └── agent-form.js
│   ├── projects-tab/
│   ├── chat-tab/
│   └── settings-tab/
└── components/
    ├── modal.js
    ├── notification.js
    └── status-badge.js
```

---

## Conclusion

The CrewSwarm dashboard is **functional but needs significant hardening** for production use. The most critical issues are:

1. **Security**: Weak auth, no input validation, command injection risk
2. **Maintainability**: 3.8k line monolith, no tests, manual routing
3. **Reliability**: Inconsistent error handling, potential memory leaks

### Recommended Next Steps

1. **Week 1**: Fix security issues (auth, input validation, CSRF)
2. **Week 2**: Add test coverage for critical paths
3. **Week 3**: Refactor routing to Express/Fastify
4. **Week 4**: Split frontend into modules

**Estimated effort**: 3-4 weeks for full remediation with a single developer

---

## Appendix: Dashboard Check Script Results

The `scripts/check-dashboard.mjs` script validates the dashboard HTML/JS syntax.

**Run Command**:
```bash
node scripts/check-dashboard.mjs --source-only
```

**Expected Output**: No errors (script exits 0)

**Common Issues Caught**:
- Unmatched quotes in inline script
- Malformed template literals
- Missing closing tags

---

## Document Meta

- **Author**: AI Agent Audit
- **Date**: 2026-03-01
- **Dashboard Version**: v1.0 (per `index.html` line 92)
- **Files Audited**:
  - `scripts/dashboard.mjs` (3,830 lines)
  - `frontend/index.html` (1,426 lines)
  - `frontend/src/app.js` (1,571 lines)
- **Total LoC Audited**: ~6,827 lines
