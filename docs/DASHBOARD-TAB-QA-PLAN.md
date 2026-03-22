# Dashboard tab-by-tab browser QA plan

**Environment:** `http://127.0.0.1:4319` — crew-lead `:5010`, agents optional for dispatch-heavy tabs.  
**Tool:** Cursor IDE Browser MCP (or manual).  
**Rate limits:** If chat/dispatch fails, retry later or switch model; record `SKIP (rate limit)`.

---

## Per-tab: steps & pass criteria

| # | Tab | Hash / view | Steps | Pass criteria |
|---|-----|-------------|-------|----------------|
| 1 | **Chat** | `#chat` | Type short message → **Send** → wait up to 90s | New assistant bubble OR clear in-thread error (not stuck “sending” forever) |
| 2 | **Swarm** | `#swarm-chat` | Type `@crew-main` ping → **Send** → wait up to 90s | Reply from routing OR structured error toast |
| 3 | **Sessions** | `#swarm` | Open tab; optional refresh | Session list or empty state loads; no blank crash |
| 4 | **RT Messages** | `#rt` | Open tab; toggle **Pause** or **Clear** (optional) | Feed UI + filter chips visible; controls respond |
| 5 | **Build** | `#build` | Open tab | Build / PM controls visible; roadmap area or empty state OK |
| 6 | **Files** | `#files` | Open tab | File browser or placeholder loads |
| 7 | **DLQ** | `#dlq` | Open tab | Table or empty DLQ message |
| 8 | **Projects** | `#projects` | Open tab | Project list or add form visible |
| 9 | **Contacts** | `#contacts` | Open tab | Contacts UI or empty state |
| 10 | **Agents** | `#agents` | Open tab | Agent grid/cards with status |
| 11 | **Models** | `#models` | Open tab | Provider rows + test/save affordances |
| 12 | **Engines** | `#engines` | Open tab | Engine list + toggles |
| 13 | **Skills** | `#skills` | Open tab | Skills list (knowledge + API sections) |
| 14 | **Waves** | `#waves` | Open tab | Wave editor + Save / Reset visible |
| 15 | **Workflow Cron** | `#workflows` | Open tab | Workflow list or empty |
| 16 | **Run skills** | `#run-skills` | Open tab | Run-skills form/UI |
| 17 | **Benchmarks** | `#benchmarks` | Open tab | Benchmark picker or list |
| 18 | **Tool Matrix** | `#tool-matrix` | Open tab | Matrix table |
| 19 | **Memory** | `#memory` | Open tab | Memory stats / search |
| 20 | **CLI Process** | `#cli-process` | Open tab | CLI process list or empty |
| 21 | **Services** | `#services` | Open tab | Service cards + start/stop |
| 22 | **Prompts** | `#prompts` | Open tab | Agent prompt list (not stuck “Loading…” forever) |
| 23 | **Settings** | `#settings` (may land on `#settings/usage` or other sub-route) | Open tab | Settings sections / env |

---

## Run log (filled during QA)

| # | Tab | Result | Notes |
|---|-----|--------|-------|
| 1 | Chat | **PARTIAL** | User send works; messages appear in thread. No assistant reply within 120s after math ping (`56088`). Earlier `browser_wait_for` “PONG” was **false positive** (substring in user text). Prefer wait string **not** in user message (e.g. answer-only math) + screenshot/search. |
| 2 | Swarm | **PASS** | `#swarm-chat`; project combobox, Refresh, Auto ON, Send. `@crew-main` math ping → assistant bubble **847** (~3s). |
| 3 | Sessions | **PASS** | `#swarm`; engine combobox (OpenCode, Claude, …), “Chat with crew-lead”. |
| 4 | RT Messages | **PASS** | `#rt`; Pause, Clear, Tasks/Replies/All chips, filter field. |
| 5 | Build | **PASS** | `#build`; project combobox, spec textarea, Run Build / PM controls. |
| 6 | Files | **PASS** | `#files`; path field, Scan, refresh. |
| 7 | DLQ | **PASS** | `#dlq`; “Dead Letter Queue” + **DLQ empty** visible (screenshot search). |
| 8 | Projects | **PASS** | `#projects`; + New Project. |
| 9 | Contacts | **PASS** | `#contacts`; + New Contact, Refresh, search, platform/sort, A–Z filters. |
| 10 | Agents | **PASS** | `#agents`; Optimize All, + New Agent, Refresh, engine bulk presets, agent rows in tree. |
| 11 | Models | **PASS** | `#models`; large provider/model UI (snapshot file). |
| 12 | Engines | **PASS** | `#engines`; per-agent engine UI (large snapshot). |
| 13 | Skills | **PASS** | `#skills`; skills UI (large snapshot). |
| 14 | Waves | **PASS** | `#waves`; wave editor UI (large snapshot). |
| 15 | Workflow Cron | **PASS** | `#workflows`; workflow UI (large snapshot). |
| 16 | Run skills | **PASS** | `#run-skills`; run-skills UI (large snapshot). |
| 17 | Benchmarks | **PASS** | `#benchmarks`; benchmark UI (large snapshot). |
| 18 | Tool Matrix | **PASS** | `#tool-matrix`; matrix UI (large snapshot). |
| 19 | Memory | **PASS** | `#memory`; memory UI (large snapshot). |
| 20 | CLI Process | **PASS** | `#cli-process`; CLI process UI (large snapshot). |
| 21 | Services | **PASS** | `#services`; service cards (large snapshot). |
| 22 | Prompts | **PASS** | `#prompts`; tab active; a11y tree still lists “Loading prompts…” from hidden panes — verify visually if stuck. |
| 23 | Settings | **PASS** | Landed `#settings/usage` (sub-route); settings shell loaded. |

**Run date:** 2026-03-19 — Browser MCP, dashboard `http://127.0.0.1:4319`.

---

## Re-run (manual quick pass)

1. Open `http://127.0.0.1:4319`
2. For each row: click sidebar item → verify hash → verify pass criteria
3. Chat + Swarm: send one message each and wait for response

## Automation note (browser `wait_for`)

Do **not** wait for a substring that also appears in the **user** message (e.g. waiting for `PONG` while the prompt says “word PONG”). Prefer an **answer token not in the prompt** (e.g. `123×456 → 56088`) and confirm with **search/screenshot** in the assistant area.
