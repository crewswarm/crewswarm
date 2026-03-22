# Orchestrator Guide

**Last Updated:** 2026-02-26

> **Primary interface:** The **Chat tab** in the dashboard (`http://127.0.0.1:4319`). Type naturally — crew-lead dispatches to crew-pm and the right agents automatically. The CLI approach below is for scripted or programmatic use.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues.

---

## How orchestration works

You give a requirement → crew-pm plans → agents execute in parallel waves → files on disk.

```
YOU: "Build user authentication"
  ↓
crew-pm: breaks into subtasks, identifies dependencies
  ↓
wave 1 (parallel)
├─→ crew-coder:    implements auth files
├─→ crew-qa:       writes tests (after wave 1)
└─→ crew-security: audits code (after wave 1)

Result: files written to project output dir ✓
```

---

## Dashboard (recommended)

1. Open `http://127.0.0.1:4319` → **Chat tab**
2. Type your requirement: `"Build JWT auth with login and register"`
3. crew-lead proposes a multi-agent plan and dispatches when you confirm
4. Watch the **Events** tab for live task progress

Or use the **Build tab** for a project-scoped build loop against a `ROADMAP.md`.

---

## CLI (scripted / power users)

```bash
node scripts/run.mjs "Build JWT-based user authentication with login, register, and password reset"
```

### CLI examples

```bash
# API feature
node scripts/run.mjs "Create rate limiting middleware that blocks after 100 requests per minute"

# UI component
node scripts/run.mjs "Add dark mode toggle to dashboard with smooth CSS transitions and localStorage persistence"

# Background job system
node scripts/run.mjs "Build background job queue using BullMQ with Redis, retries, and a monitoring UI"
```

---

## What happens behind the scenes

### 1. PM receives the task
- Analyzes the requirement
- Breaks it into subtasks with dependencies
- Assigns each subtask to the right agent

### 2. Agents execute in parallel waves

| Wave | Agents | What happens |
|------|--------|-------------|
| 1 | crew-coder | Implements the code |
| 2 | crew-qa, crew-security | Tests + security audit (parallel, after wave 1) |
| 3 | crew-github | Commits when review passes |

### 3. PM reports final status

```
✅ Implementation: 5 files created
✅ Tests: 38 tests, 94% coverage
✅ Security: 0 issues found
✅ Committed to git
```

---

## Writing good requirements

**Be specific and include context:**

| Bad | Good |
|-----|------|
| `"Build auth"` | `"Build JWT auth with login, register, logout endpoints"` |
| `"Add dark mode"` | `"Add dark mode toggle to dashboard, persist in localStorage"` |
| `"Create API"` | `"Create REST API at /api/users with CRUD, auth middleware"` |

---

## Pipeline DSL (advanced)

Send a pipeline directly from the Chat tab or API:

```
@@PIPELINE [
  {"wave":1, "agent":"crew-coder",    "task":"Write /src/auth.ts — JWT login"},
  {"wave":2, "agent":"crew-qa",       "task":"Test the auth endpoint"},
  {"wave":3, "agent":"crew-github",   "task":"Commit and open a PR"}
]
```

Tasks in the same `wave` run in parallel. Higher waves wait for lower waves.

---

## Troubleshooting

**Agents not responding:**
```bash
npm run health          # check all services
npm run restart-all     # restart everything
```

**Pipeline timeout:**
```bash
# Check which agent is stuck
tail -f /tmp/bridge-crew-coder.log

# Restart a specific bridge
node scripts/start-crew.mjs --restart crew-coder
```

**Token / auth errors:**
See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — "Token alignment" section.

---

## Stopping a run

| Command | Effect |
|---------|--------|
| `@@STOP` in chat | Graceful — cancel queued pipeline waves, stop PM loop |
| `@@KILL` in chat | Hard — all of the above + kills agent bridge processes |
| Dashboard → Build tab → Stop | Stops the active phased/continuous build |
