# Contributing to CrewSwarm

Thanks for your interest. CrewSwarm is an active project and contributions are welcome — bug fixes, new skills, agent improvements, and docs all matter.

---

## Quick start

```bash
git clone https://github.com/jeffhobbs/CrewSwarm.git
cd CrewSwarm
npm install
bash install.sh
```

You'll need at least one API key (Groq is free: https://console.groq.com/keys) to run the crew.

---

## What to work on

The [`FIXES.md`](FIXES.md) file has a prioritized list of known issues from a recent audit — great place to start. Open issues on GitHub are the other source of truth.

Good first issues are tagged [`good first issue`](../../issues?q=label%3A%22good+first+issue%22).

---

## Project layout

| Path | What lives here |
|---|---|
| `crew-lead.mjs` | Conversational commander + HTTP API (port 5010) |
| `gateway-bridge.mjs` | Per-agent daemon — LLM calls, tool execution, engine routing |
| `scripts/dashboard.mjs` | Dashboard API server (port 4319) |
| `frontend/` | Vite dashboard UI — **edit here, not `dashboard.mjs`** |
| `scripts/` | Utilities: health check, RT daemon, start/restart scripts |
| `skills/` | Bundled skill plugins (JSON data files — no code needed) |
| `memory/` | Persistent knowledge base (`brain.md`, laws, lessons) |
| `docs/` | Architecture, orchestration guides, troubleshooting |

---

## Making changes

### Frontend (dashboard UI)

The real dashboard UI is **not** in `dashboard.mjs` — it lives in `frontend/`.

```bash
# Edit frontend/index.html or frontend/src/app.js
cd frontend && npm run build
# Restart dashboard to serve new build
pkill -f "dashboard.mjs" && node scripts/dashboard.mjs &
```

### Backend / agents

`crew-lead.mjs` and `gateway-bridge.mjs` are the two large core files. Both are plain ESM Node.js — no build step needed. Restart the relevant process after editing:

```bash
pkill -f "crew-lead.mjs" && node crew-lead.mjs &
# or for agent bridges:
node scripts/start-crew.mjs
```

### Skills (no code required)

Drop a JSON file in `skills/` and it's automatically available to all agents. See an existing skill like `skills/zeroeval.benchmark.json` as a template. Full spec in `AGENTS.md` → "Skill plugins".

---

## Testing your change

```bash
node scripts/health-check.mjs          # all services + agents
node scripts/check-dashboard.mjs       # validate dashboard HTML/JS
```

There are smoke tests in `__tests__/`:

```bash
npm test
```

If you're adding a new agent capability or skill, a quick smoke test in `__tests__/` is appreciated but not required for a first PR.

---

## Pull request checklist

- [ ] `node scripts/check-dashboard.mjs --source-only` passes if you touched dashboard files
- [ ] No personal files, API keys, or private paths committed (check with `git diff --staged`)
- [ ] `~/.crewswarm/` paths are never hardcoded — use `os.homedir()` + `path.join`
- [ ] New env vars are documented in `AGENTS.md` or the relevant section of `README.md`
- [ ] PR description explains *why*, not just *what*

---

## Commit style

Plain imperative subject line, 72 chars max:

```
fix: prevent dispatch loop when crew-lead echoes past-tense replies
feat: add Codex CLI as fourth passthrough engine
docs: add CONTRIBUTING.md and GitHub issue templates
```

No ticket numbers required. No emoji unless the file already uses them.

---

## Code style

- ESM (`import`/`export`) throughout — no CommonJS `require()`
- Imports at the top of the file (no inline imports mid-function)
- No comments that just narrate the code — only explain non-obvious intent
- Prefer `const` over `let`; avoid `var`
- 2-space indent

---

## Questions?

Open a [discussion](../../discussions) or a [question issue](../../issues/new?template=question.yml). The crew is also reachable via the dashboard chat if you're running it locally.
