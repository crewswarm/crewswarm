# Dashboard & Chat QA Plan

Manual / semi-automated QA for `http://127.0.0.1:4319` (Vite UI + `scripts/dashboard.mjs` API).

**Rate limits:** If a flow uses Cursor / Claude / Codex / Gemini CLIs or external APIs, retry with a different engine or model, or wait and re-run.

---

## Sidebar views (each page)

| # | View | `data-view` | Primary checks |
|---|------|-------------|----------------|
| 1 | Chat | `chat` | Crew-lead chat, @mentions, dispatch hints, STOP/KILL, passthrough, image/voice if enabled |
| 2 | Swarm | `swarm-chat` | Unified chat `/api/chat/unified`, project picker, @agents |
| 3 | Sessions | `swarm` | Session list, messages, engine labels |
| 4 | RT Messages | `rt` | Live bus, pause/clear, filter chips |
| 5 | Build | `build` | Build start/stop, log |
| 6 | Files | `files` | File tree / content (if present) |
| 7 | DLQ | `dlq` | Queue list, replay/delete |
| 8 | Projects | `projects` | CRUD, roadmap path |
| 9 | Contacts | `contacts` | List / prefs (if wired) |
| 10 | Agents | `agents` | Status, models, OpenCode flags |
| 11 | Models | `models` | Provider keys, test, fetch models |
| 12 | Engines | `engines` | Toggle engines, import |
| 13 | Skills | `skills` | Knowledge + API skills, import |
| 14 | Waves | `waves` | Wave editor, save, run wave |
| 15 | Workflow Cron | `workflows` | List/save/run cron pipelines |
| 16 | Run skills | `run-skills` | Skill-only runs |
| 17 | Benchmarks | `benchmarks` | ZeroEval lists |
| 18 | Tool Matrix | `tool-matrix` | Per-agent tools |
| 19 | Memory | `memory` | Stats, search, migrate |
| 20 | CLI Process | `cli-process` | Attached CLIs |
| 21 | Services | `services` | Start/stop/restart |
| 22 | Prompts | `prompts` | Load/save per-agent prompts |
| 23 | Settings | `settings` | Env, communications, tokens |

---

## Chat & orchestration flows

| # | Flow | What to verify |
|---|------|----------------|
| A | **Crew-lead chat (default)** | Message → reply from Stinki/crew-lead; history reload |
| B | **Direct agent** | Agent selector → `chat-agent` / direct path; reply attributed to agent |
| C | **Dispatch** | “dispatch crew-X …” or equivalent → task visible in RT / completion |
| D | **@@PIPELINE / waves** | Multi-wave run; ordering; per-agent output |
| E | **PM loop** | Start/stop from Build or PM UI; roadmap panel; log |
| F | **Passthrough** | Engine passthrough (Cursor/Claude/Gemini/Codex) if configured |
| G | **STOP / KILL** | Cancels pipelines; documented behavior |
| H | **Project-scoped chat** | Project selected → messages tied to `projectId` |

---

## Task execution order (suggested)

1. **Task 1 — Baseline (automated):** Dashboard + crew-lead up; read-only GET APIs return 200. *(done — see below)*
2. **Task 2:** Open each sidebar view; confirm no blank error state, no console 404 for main bundle.
3. **Task 3:** Chat — send “hello”; confirm reply.
4. **Task 4:** Direct agent — pick `crew-main` or `crew-qa`; short task.
5. **Task 5:** Dispatch — one-line dispatch to `crew-main` (cheap model); confirm completion.
6. **Task 6:** Waves — save minimal 1-agent wave; run (retry on rate limit).
7. **Task 7:** PM loop — dry run or single item; stop cleanly.
8. **Task 8:** Swarm chat — unified endpoint with test message.

---

## Task 1 results (run locally)

**Date:** 2026-03-19 (agent run)

| Check | Result |
|-------|--------|
| `GET http://127.0.0.1:4319/` | 200 |
| `GET http://127.0.0.1:5010/health` | `{"ok":true,...}` |
| `GET /api/agents` | 200 |
| `GET /api/projects` | 200 |
| `GET /api/rt-messages` | 200 |
| `GET /api/waves/config` | 200 |
| `GET /api/pm-loop/status?projectId=default` | 200 |
| `GET /api/dlq` | 200 |
| `GET /api/chat-participants` | 200 |
| `GET /api/crew-lead/status` | 200 |
| `GET /api/skills` | 200 |
| `GET /api/memory/stats` | 200 |
| `GET /api/prompts` | 200 |
| `GET /api/services/status` | 200 |
| `GET /api/zeroeval/benchmarks` | 200 |

**Task 1 verdict:** PASS — stack reachable; core read-only APIs OK. Does **not** validate LLM/CLI execution (Tasks 3–8).

**Re-run Task 1:**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4319/
curl -sS http://127.0.0.1:5010/health
for p in /api/agents /api/projects /api/rt-messages /api/waves/config /api/dlq /api/chat-participants /api/crew-lead/status; do
  echo -n "$p "; curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:4319$p"
done
```

---

## Related

- `docs/CANONICAL/TESTING.md` — repo smoke (`npm run smoke`), Playwright note
- `docs/CANONICAL/ROUTING.md` — shared chat, mentions, dispatch
