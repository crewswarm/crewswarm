# CrewSwarm — Fix Plan

> Generated 2026-02-26. Rated from comprehensive 3-agent audit of gateway-bridge.mjs, crew-lead.mjs, pm-loop.mjs, dashboard.mjs, and website/.
> Current score: **7.2 / 10**. Target after all fixes: **9.0+**

---

## CRITICAL — Broken (fix immediately)

### C1 — DLQ replay path mismatch
**What:** `dlq-replay.mjs` reads from `~/.crewswarm/logs/dlq` but gateway-bridge writes DLQ entries to `~/.crewswarm/workspace/shared-memory/claw-swarm/opencrew-rt/dlq`. Every "Retry" click in the dashboard silently fails.  
**Fix:** Update `dlq-replay.mjs` to read from the same path gateway-bridge uses, OR add a constant both files import from a shared config.  
**Files:** `scripts/dlq-replay.mjs`, `gateway-bridge.mjs`

### C2 — Claude Code mode silently does not save
**What:** Gateway-bridge reads `agent.useClaudeCode` and `agent.claudeCodeModel` from crewswarm.json. The dashboard shows Claude Code route buttons. But `/api/agents-config/update` never writes `useClaudeCode` or `claudeCodeModel` — they're stripped from the body destructuring. Setting Claude Code mode does nothing.  
**Fix:** Add `useClaudeCode`, `claudeCodeModel` to destructuring and update logic in the POST handler.  
**Files:** `scripts/dashboard.mjs` (line ~7693)

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

### H4 — PM Loop options entirely env-only
**What:** QA toggle, security toggle, specialist routing, max items, task timeout, extend behavior, coder agent, pause between tasks, max retries — none are configurable from the PM Loop tab.  
**Fix:** Add an "Advanced Options" collapsible section to the PM Loop tab with toggles/inputs for: QA enabled, security enabled, use specialists, max items, task timeout (min), extend every N, default coder agent.  
**Files:** `scripts/dashboard.mjs`, `pm-loop.mjs` (pass as env to spawned process)

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

### M10 — Many important env vars have zero dashboard exposure
**What:** ~35 env vars control meaningful behavior (dispatch timeouts, retry limits, reconnect delays, memory namespace, etc.) with no dashboard visibility or editability.  
**Fix (phased):** Add an "Advanced / Environment" section to Settings that shows current values of key operational env vars (read-only first, then editable for the most useful ones like timeouts and retry counts).  
**Files:** `scripts/dashboard.mjs`, `scripts/dashboard.mjs` API section

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
| 1 | C1 | 30min | DLQ is completely broken |
| 2 | C2 | 30min | Claude Code mode silently broken |
| 3 | H1 | 1hr | @@STOP/@@KILL UX critical for autonomous mode |
| 4 | H2 | 1hr | Projects unusable without edit |
| 5 | H3 | 30min | DLQ unmanageable without delete |
| 6 | H4 | 2hr | PM loop power users locked out of all config |
| 7 | H6 | 3hr | Mobile — kills any phone/tablet use |
| 8 | H5 | 1hr | Global loop toggle |
| 9 | M1–M4 | 2hr | Loading/error UX polish |
| 10 | L1–L6 | 2hr | CSS cleanup and accessibility |

**Total estimated effort: ~14 hours**
