# CrewSwarm — Fix Plan

> Generated 2026-02-26. Rated from comprehensive 3-agent audit of gateway-bridge.mjs, crew-lead.mjs, pm-loop.mjs, dashboard.mjs, and website/.
> Current score: **7.2 / 10**. Target after all fixes: **9.0+**

---

## CRITICAL — Broken (fix immediately)

### C1 — DLQ replay path mismatch ✅ FIXED
`dlq-replay.mjs` now uses `SHARED_MEMORY_BASE`/`SHARED_MEMORY_NAMESPACE` constants matching gateway-bridge exactly.

### C2 — Claude Code mode silently does not save ✅ FIXED
`useClaudeCode` and `claudeCodeModel` are now destructured and persisted in `/api/agents-config/update`.

---

## HIGH — Missing Feature

### H1 — No @@STOP / @@KILL buttons in dashboard
**What:** The only way to halt a running pipeline is to type `@@STOP` or `@@KILL` in chat. No UI button exists.  
**Fix:** Add a prominent "⏹ Stop Pipeline" and "☠️ Kill All" button to the Services tab or chat toolbar. POST to `/api/pipeline/stop` (or send via crew-lead chat API).  
**Files:** `scripts/dashboard.mjs`

### H2 — Projects: no edit after creation
**What:** After creating a project you cannot change its name, description, or outputDir. `/api/projects/update` only handles `autoAdvance`.  
**Fix:** Add edit fields to project cards. Extend `/api/projects/update` to accept name, description, outputDir.  
**Files:** `scripts/dashboard.mjs`

### H3 — No DLQ delete
**What:** DLQ items can be retried but never cleared from the UI. Stale/permanent failures pile up forever.  
**Fix:** Add `DELETE /api/dlq/:key` endpoint. Add ✕ button per DLQ row.  
**Files:** `scripts/dashboard.mjs`

### H4 — PM Loop options entirely env-only ✅ FIXED
PM Loop tab now has: QA, security, specialist routing toggles; max items, task timeout, extend every N, coder agent, max retries, pause inputs. All passed as env to spawned pm-loop process.

### H5 — No global OpenCode loop toggle
**What:** `CREWSWARM_ENGINE_LOOP=1` enables the Ouroboros loop for ALL agents. Per-agent `opencodeLoop` checkbox exists but there's no global toggle or `CREWSWARM_ENGINE_LOOP_MAX_ROUNDS` input.  
**Fix:** Add global OpenCode loop toggle + max rounds input to Settings → Execution tab.  
**Files:** `scripts/dashboard.mjs`

### H6 — No mobile layout
**What:** Zero `@media` queries in the dashboard. Fixed 216px sidebar, fixed grid splits, fixed pixel widths everywhere. Completely broken on any screen under ~1100px wide.  
**Fix:** Add responsive breakpoints: collapse sidebar to icon-only at <768px, stack grids at <640px, make agent cards single-column on mobile.  
**Files:** `scripts/dashboard.mjs` (CSS section)

### H7 — Cmd approval uses hardcoded crew-lead URL
**What:** Approve/reject command buttons call `fetch('http://127.0.0.1:5010/approve-cmd')` directly with no `.catch()`. If crew-lead port changes (via `CREW_LEAD_PORT` env) these silently fail.  
**Fix:** Route through dashboard proxy at `/api/cmd-allowlist/approve` and `/api/cmd-allowlist/reject`. Add error handling.  
**Files:** `scripts/dashboard.mjs`

---

## MEDIUM — Poor UX

### M1 — No loading states on most async tabs
**What:** RT Messages, DLQ, Sessions, Messages tabs clear their content then show nothing while fetching. Users see blank boxes.  
**Fix:** Add a simple "Loading…" skeleton or spinner before each async fetch populates the container.  
**Files:** `scripts/dashboard.mjs`

### M2 — No loading/disabled state on chat send
**What:** After hitting Send in chat, the input stays active with no feedback. User can spam messages.  
**Fix:** Disable input + show "Sending…" indicator while the fetch is in flight. Re-enable on response.  
**Files:** `scripts/dashboard.mjs`

### M3 — `resetSpending` uses wrong notification signature
**What:** `resetSpending` catch block calls `showNotification('Reset failed', 'error')` but the function signature is `showNotification(msg, isError)` where `isError` should be `true` (boolean), not the string `'error'`.  
**Fix:** Change to `showNotification('Reset failed', true)`.  
**Files:** `scripts/dashboard.mjs`

### M4 — RT Messages has no search or filter
**What:** As message volume grows the RT Messages tab becomes unusable with no way to filter by agent or type.  
**Fix:** Add a text filter input that filters visible messages by agent name or message content.  
**Files:** `scripts/dashboard.mjs`

### M5 — Hardcoded `localhost:4319` in sidebar
**What:** The sidebar footer link hardcodes `http://localhost:4319` ignoring the `SWARM_DASH_PORT` env var.  
**Fix:** Replace with a server-side interpolated value using the actual `listenPort` variable.  
**Files:** `scripts/dashboard.mjs` (line ~602)

### M6 — PM draft project cards use ~20 hardcoded colors
**What:** The PM project draft cards in Build tab use raw hex/rgba values (`#0a0a12`, `#0d1f3c`, `#1e3a6e`, etc.) instead of CSS variables, making them inconsistent with the design system.  
**Fix:** Replace with `var(--bg-card)`, `var(--border)`, `var(--accent)` equivalents.  
**Files:** `scripts/dashboard.mjs`

### M7 — Cmd allowlist fetch calls missing `.catch()`
**What:** Add pattern, delete pattern, and preset toggle all use `fetch()` with no error handling. Failures are silent.  
**Fix:** Add `.catch(e => showNotification('Failed: ' + e.message, true))` to each.  
**Files:** `scripts/dashboard.mjs`

### M8 — `demo/index.html` stale branding
**What:** `demo/index.html` (if served) still says "OpenClaw Swarm + GPT 5 Codex" in title and h1.  
**Fix:** Update to CrewSwarm branding or remove the file if not needed.  
**Files:** `demo/index.html`

### M9 — `var(--purple)` and `var(--warning)` referenced but undefined
**What:** Several CSS/inline styles reference `var(--purple)` and `var(--warning)` which are not defined in `:root`. They silently fall back to nothing.  
**Fix:** Add `--purple: #a855f7` and `--warning: #f59e0b` to `:root` in the dashboard CSS.  
**Files:** `scripts/dashboard.mjs` (CSS section)

### M10 — Many important env vars have zero dashboard exposure ✅ FIXED
Security tab now exposes all 39 env vars (up from 27). All new watchdog, PM loop, Gemini CLI, and dispatch vars are visible and editable with defaults pre-filled.

---

## LOW — Cosmetic / Tech Debt

### L1 — ~12 hardcoded hex colors in buttons/badges
**What:** `.btn-sky`, `.status-active`, `.status-stopped`, nav badge, and bulk setter buttons use hardcoded `#22c55e`, `#ef4444`, `#38bdf8`, etc. instead of CSS variables.  
**Fix:** Add `--green`, `--red`, `--sky` to `:root` and replace all hardcoded values.  
**Files:** `scripts/dashboard.mjs`

### L2 — Provider and agent card markup duplicated
**What:** Provider cards, agent cards, and status badges are each rendered by large inline string templates repeated 3–5 times each.  
**Fix:** Extract into `renderAgentCard(a)`, `renderProviderCard(p)`, `renderStatusBadge(liveness)` JS functions.  
**Files:** `scripts/dashboard.mjs`

### L3 — Shared UI patterns repeated 15+ times
**What:** Loading placeholder (`<div class="meta">Loading…</div>`), empty state, and error display are copy-pasted everywhere.  
**Fix:** Add `showLoading(el)`, `showEmpty(el, msg)`, `showError(el, msg)` helper functions.  
**Files:** `scripts/dashboard.mjs`

### L4 — Accessibility gaps
**What:** Several inputs lack `<label>` associations (`#chatInput`, `#filesDir`, `#newRoleName`, `#newRoleTools`). Command approval toast has no `role="alert"`. Emoji picker has no keyboard navigation.  
**Fix:** Add `<label for="...">` or `aria-label` to unlabelled inputs. Add `role="alert"` to approval toast.  
**Files:** `scripts/dashboard.mjs`

### L5 — `website/ROADMAP.md` has many OpenCrewHQ references
**What:** Internal roadmap file still uses old brand name throughout. Not user-facing but confusing during development.  
**Fix:** Find/replace OpenCrewHQ → CrewSwarm in ROADMAP.md.  
**Files:** `website/ROADMAP.md`

### L6 — `/api/env` endpoint exposed but unused
**What:** GET `/api/env` returns `{HOME, cwd}` with no UI consumer.  
**Fix:** Either wire it to a "System Info" display in Settings or remove the endpoint.  
**Files:** `scripts/dashboard.mjs`

---

## Fixed in Session 7 (2026-02-27) ✅

- **Runaway processes** — `restart-all-from-repo.sh` now uses broad `pkill -f` patterns; kills `crew-scribe`; uses absolute paths; guards MCP port with `lsof`
- **PM loop hanging** — Activity-based watchdog in `lib/engines/runners.mjs` (idle + absolute max); adaptive deadline in `pm-loop.mjs`; binary existence check for early failure
- **Env vars tab empty** — Inputs now pre-populate with code defaults (`saved ?? def ?? ''`); "default" badge shown; all 39 vars surfaced (up from 27); **M10 ✅**
- **Provider key detection** — `BUILTIN_URLS` expanded to include Cerebras, NVIDIA, Google, Together, Cohere; "no key" / "Failed to parse URL" errors eliminated
- **Default values dim text** — Restored white text for default values (was accidentally dimmed to `var(--text-3)`); opacity 0.65 now indicates defaults without losing readability
- **Tests: 408 total** — Added 129 new tests (bg-consciousness, Ouroboros loop, PM synthesis, all 12 new env vars, Telegram round-trip E2E); 0 failures
- **Docs cleanup** — Archived completed plan docs (crew-lead split, agent migration, OpenClaw ref audit, session summary, refactor plan); deleted stale agent output files from repo root; **C1 ✅ C2 ✅ H4 ✅ M10 ✅**

## Fixed in Session 6 (2026-02-27) ✅

- **God-file final round** — `crew-lead.mjs` 3560 → 2411 (−33%), `gateway-bridge.mjs` 2561 → 2251 (−12%), `frontend/src/app.js` 1977 → 1350 (−32%) — 5 new modules: `lib/crew-lead/http-server.mjs`, `lib/engines/llm-direct.mjs`, `lib/engines/opencode.mjs`, `frontend/src/tabs/usage-tab.js`, `frontend/src/tabs/spending-tab.js`, `frontend/src/tabs/pm-loop-tab.js`
- **L4** — `<label for>` associations added to all remaining New Agent form inputs (`#naId`, `#naModel`, `#naName`, `#naTheme`, `#naPrompt`); `aria-label` on prompt preset select; `role="alert"` + `aria-live` confirmed present on notification toasts (already in `core/dom.js`)
- **C1** — Confirmed already fixed: `dashboard.mjs`, `dlq-replay.mjs`, `gateway-bridge.mjs` all resolve to the same DLQ path (`~/.crewswarm/workspace/shared-memory/claw-swarm/opencrew-rt/dlq`)
- **M9** — Confirmed already fixed: `--purple: #818cf8` and `--warning: #f59e0b` present in `frontend/src/styles.css :root`
- **H4** — Confirmed already fixed: PM Loop ⚙ Options panel with QA, Security, specialists, maxItems, timeout, extend-N, pause, maxRetries, coder agent — all present in `frontend/index.html`
- **Runtime bugs** — Fixed `_rtClientForApprovals not defined` ReferenceError crashing all agent bridges + flooding RT bus; fixed RT Messages tab stuck on "Loading…" (type mismatch `task.done` not in RT_TASK_TYPES + early-return bug); fixed `applyNewAgentToolPreset`/`applyPromptPreset` not exported — crashed all dashboard onclick handlers
- **Vite bundle** — Rebuilt with 21 modules (up from 18)

---

## Fixed in Session 5 (2026-02-27) ✅

- **God-file splits** — `gateway-bridge.mjs` 5408 → 3954 lines (−27%), `crew-lead.mjs` 5458 → 5169 lines (−5%)
- **9 new modules** extracted into `lib/`: `skills/index.mjs` (223), `runtime/spending.mjs` (127), `tools/executor.mjs` (676), `runtime/task-lease.mjs` (198), `runtime/utils.mjs` (52), `dispatch/parsers.mjs` (215), `chat/history.mjs` (31), `agents/permissions.mjs` (73), `runtime/memory.mjs` (290) — **1,885 lines total extracted**
- **L2** — `renderStatusBadge`, `showLoading`, `showEmpty`, `showError` added to `core/dom.js`; imported by `agents-tab.js` + `models-tab.js`; duplicate local definitions removed
- **L3** — `showLoading/Empty/Error` wired into `loadOcStats`, `loadProviders`, replacing all inline `div.innerHTML` loading strings
- **C2** — Confirmed already fixed: `useClaudeCode` + `claudeCodeModel` present in `/api/agents-config/update` destructuring and write logic
- **Benchmark runner** — `GET /api/benchmark-tasks` + `POST /api/benchmark-run` added to `dashboard.mjs` (SWE-bench Verified + LiveCodeBench via HuggingFace dataset rows API)
- **Vite bundle** — Rebuilt with hash `index-B2cCpwbp.js`

---

## Fixed in Session 4 (2026-02-27) ✅

- **H6** — Mobile responsive layout: `@media` queries at 1100px, 768px, 480px — sidebar collapses to horizontal nav bar, grids go single-column, chat row wraps
- **L1** — Hardcoded hex colors replaced with CSS variables (`--green`, `--red`, `--sky`, `--amber`) in styles, HTML, and inline JS styles
- **L4** — Accessibility: `aria-label` on chat input + send button, `role="alert"` + `aria-live="polite"` on notifications, `<label for>` on project name, outputDir, files dir inputs
- **M10** — Environment Variables card in Settings → System: shows cwd, node version, uptime + 21 operational env vars via new `/api/env-advanced` endpoint
- **L6** — `/api/env` now returns useful system info (HOME, cwd, node, pid, uptime, platform); wired into env-advanced widget
- **Vite bundle** — Rebuilt with new hash `index-D6SGSZsm.js`

---

## Fixed in Session 3 (2026-02-27) ✅

- **M5** — Sidebar `localhost:4319` replaced with `window.location.origin` (dynamic, works on any port)
- **M7** — Cmd allowlist add/delete/toggle all have `.catch()` error handling with `showNotification`
- **C1** — Confirmed already fixed: `dlq-replay.mjs` and `gateway-bridge.mjs` both use `~/.crewswarm/workspace/shared-memory/claw-swarm/opencrew-rt/dlq`
- **Claude Code cost tracking** — `runClaudeCodeTask()` now captures `ev.modelUsage` + `ev.total_cost_usd` from result event, feeds real USD into spending caps + token dashboard
- **WhatsApp crash loop** — Added `httpServer.on("error")` handler; `EADDRINUSE` now logs warning instead of killing the process
- **Vite bundle** — Rebuilt with new hash `index-B0fKPbge.js`; all new features confirmed in built output
- **QA run** — Full E2E audit passed (31 items passing, 0 critical failures)

---

## Fixed in Session 2 (2026-02-27) ✅

- **Dead code trap eliminated** — removed 6,232-line inline HTML fallback from `scripts/dashboard.mjs`; archived to `archive/dashboard-inline-html-legacy.mjs`; added workspace rule `.cursor/rules/dashboard-ui-location.mdc` to prevent future agents editing the wrong file
- **H1** — ⏹ Stop + ☠️ Kill buttons added to chat toolbar in `frontend/index.html` + `frontend/src/app.js`
- **H2** — Inline project editing (name, description, outputDir) — Edit button on project cards
- **H3** — DLQ delete button — `DELETE /api/dlq/:key` backend + Delete button per row
- **H4** — PM Loop advanced options — collapsible panel with useQA, useSecurity, maxItems, timeout, coder agent, etc.
- **H5** — Global OpenCode Loop (Ouroboros) toggle + max rounds in Settings → System
- **H7** — Cmd approval now proxies through `/api/cmd-approve` / `/api/cmd-reject` (no more hardcoded 5010)
- **M1** — Loading states on RT Messages, DLQ, Sessions
- **M2** — Chat input disabled + "Sending…" during send
- **M3** — `showNotification` boolean arg fixed in `resetSpending`
- **M6** — PM draft card colors use CSS variables
- **M9** — `--warning` CSS variable added to `:root`
- **Context windows** — model effective context window data saved to `memory/model-context-windows.md` + key routing rules added to `memory/lessons.md` (injected into crew-lead every session)
- All Vite changes rebuilt (`cd frontend && npm run build`) and confirmed live

---

## Already Fixed This Session ✅

- `shouldUseCursorCli` hardcoded for orchestrator — bypassed dashboard config → **fixed**
- `OC_AGENT_MAP` missing crew-main, crew-copywriter, crew-github, crew-orchestrator → **fixed**
- `AGENT_TO_OC_PROFILE` missing same agents, silently skipping config sync → **fixed**
- Custom agent names (no `crew-` prefix) couldn't route correctly → **fixed**
- New `_role` values not supported — silently ignored → **fixed** (roleToolDefaults)
- Dashboard GET `/api/agents-config` missing useCursorCli, opencodeFallbackModel, cursorCliModel → **fixed**
- `_role` dropdown, `opencodeLoop` toggle, `workspace` field not in dashboard → **fixed**
- `global-rules.md` not editable from dashboard → **fixed**
- Background consciousness interval + model not configurable → **fixed**
- Spending caps not editable → **fixed**
- Custom roles (roleToolDefaults) not manageable from dashboard → **fixed**
- Role/Theme field plain text only → **fixed** (datalist with 20 presets)
- Services badge counting OpenClaw (optional/legacy) as critical → **fixed**
- Create Agent tools grid showing raw JS template code → **fixed**
- 404.html stale OpenCrewHQ branding, missing favicon/OG → **fixed**
- `llms.txt` missing for AI crawlers → **fixed**
- Sitemap containing illegal external URLs → **fixed**
- robots.txt missing explicit AI crawler rules → **fixed**
- Favicon Cloudflare cache showing old version → **fixed** (version bust `?v=2`)
- Stinki card purple → blue → **fixed**

---

## Priority Order for Remaining Fixes

| Priority | ID | Effort | Impact |
|---|---|---|---|
| ~~1~~ | ~~C1~~ | ~~30min~~ | ~~DLQ is completely broken~~ ✅ Fixed |
| ~~2~~ | ~~C2~~ | ~~30min~~ | ~~Claude Code mode silently broken~~ ✅ Fixed |
| 1 | H1 | 1hr | @@STOP/@@KILL UX critical for autonomous mode |
| 2 | H2 | 1hr | Projects unusable without edit |
| 3 | H3 | 30min | DLQ unmanageable without delete |
| 6 | H4 | 2hr | PM loop power users locked out of all config |
| 7 | H6 | 3hr | Mobile — kills any phone/tablet use |
| 8 | H5 | 1hr | Global loop toggle |
| 9 | M1–M4 | 2hr | Loading/error UX polish |
| 10 | L1–L6 | 2hr | CSS cleanup and accessibility |

**Total estimated effort: ~14 hours**
