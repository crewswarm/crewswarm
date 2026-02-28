# Contributing to CrewSwarm

Thanks for your interest. CrewSwarm is an active project and contributions are welcome — bug fixes, new skills, agent improvements, and docs all matter.

---

## Quick start

```bash
git clone https://github.com/CrewSwarm/CrewSwarm.git
cd CrewSwarm
npm install
bash install.sh
```

You'll need at least one API key (Groq is free: https://console.groq.com/keys) to run the crew.

---

## What to work on

The [`FIXES.md`](FIXES.md) file has a prioritized list of known issues — great place to start. Open issues on GitHub are the other source of truth.

Good first issues are tagged [`good first issue`](../../issues?q=label%3A%22good+first+issue%22).

---

## Project layout

| Path | What lives here |
|---|---|
| `crew-lead.mjs` | Conversational commander + HTTP API (port 5010) |
| `gateway-bridge.mjs` | Per-agent daemon — LLM calls, tool execution, engine routing |
| `lib/crew-lead/` | Chat handler, wave dispatcher, LLM caller, prompts, HTTP server |
| `lib/engines/` | Engine runners (Cursor CLI, Claude Code, Gemini, Codex), Ouroboros loop |
| `lib/pipeline/` | Project draft/confirm, roadmap AI generation |
| `lib/skills/` | Skill loader — handles both `.json` API skills and `SKILL.md` knowledge skills |
| `lib/tools/` | `@@TOOL` marker parser and executor |
| `scripts/dashboard.mjs` | Dashboard API server (port 4319) — UI is **not** here |
| `frontend/` | Vite dashboard UI — **edit `frontend/src/`, build with `npm run build`** |
| `pm-loop.mjs` | Autonomous PM loop — reads ROADMAP.md, dispatches items |
| `skills/` | Bundled skill plugins shipped with the repo |
| `~/.crewswarm/skills/` | User-installed skills (JSON + SKILL.md) |
| `memory/` | Shared agent context (brain.md, laws, lessons) |
| `test/unit/` | Unit tests — no services needed |
| `test/integration/` | Integration tests — no services needed |
| `test/e2e/` | E2E tests — require `npm run restart-all` first |
| `docs/` | Architecture, orchestration guides, troubleshooting |

---

## Development setup

```bash
# Install dependencies
npm install

# Run setup (creates ~/.crewswarm/ config)
bash install.sh

# Start everything
npm run restart-all

# Dashboard at http://127.0.0.1:4319
# crew-lead API at http://127.0.0.1:5010
```

---

## Making changes

### Frontend (dashboard UI)

> ⚠️ The UI lives in `frontend/` — **not** `scripts/dashboard.mjs`. Dashboard.mjs is the API backend.

```bash
# 1. Edit frontend/index.html or frontend/src/app.js or frontend/src/styles.css
# 2. Build
cd frontend && npm run build
# 3. Restart dashboard
pkill -f "dashboard.mjs" && node scripts/dashboard.mjs &
# 4. Validate (run after every dashboard change)
node scripts/check-dashboard.mjs --source-only
```

### Backend (crew-lead, gateway-bridge)

Plain ESM Node.js — no build step. Restart the affected process:

```bash
# crew-lead
pkill -f "crew-lead.mjs" && node crew-lead.mjs &

# All agent bridges
pkill -f "gateway-bridge.mjs" && node scripts/start-crew.mjs

# Single bridge (e.g. crew-coder)
pkill -f "crew-coder" && node gateway-bridge.mjs crew-coder &
```

### Adding a knowledge skill (SKILL.md — no code)

Knowledge skills are Markdown playbooks agents read when they call `@@SKILL skillname {}`.

```bash
mkdir -p ~/.crewswarm/skills/my-skill
cat > ~/.crewswarm/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: One sentence describing when to use this skill.
aliases: [my-skill-alias]
---

# My Skill

## Section 1
Content here — frameworks, checklists, decision trees.

## Section 2
More content.
EOF
```

The skill is immediately available — no restart needed. Test it: `@@SKILL my-skill {}` in the dashboard chat.

### Adding an API skill (JSON — calls an external endpoint)

API skills make real HTTP calls (post a tweet, deploy to Fly, call an API):

```bash
cat > ~/.crewswarm/skills/my-api.json << 'EOF'
{
  "description": "What this skill does",
  "url": "https://api.example.com/endpoint",
  "method": "POST",
  "auth": { "type": "bearer", "keyFrom": "providers.example" },
  "defaultParams": { "param1": "value1" },
  "paramNotes": "param1: string (required)"
}
EOF
```

Or use the dashboard Skills tab → **+ New API Skill** form.

### Adding a new agent

1. Add an entry to `~/.crewswarm/crewswarm.json`:
```json
{ "id": "crew-myagent", "model": "groq/llama-3.3-70b-versatile" }
```

2. Add a system prompt to `~/.crewswarm/agent-prompts.json`:
```json
{ "myagent": "You are crew-myagent. Your specialty is X. Always @@WRITE_FILE your output." }
```

3. Optionally add a skill reference to the prompt:
```json
{ "myagent": "You are crew-myagent...\n\n## Your Skill: my-skill\nUse @@SKILL my-skill {} when doing X." }
```

4. Restart bridges — the new agent auto-registers on the RT bus.

```bash
node scripts/start-crew.mjs
```

---

## Testing

### Run unit + integration tests (no services needed)

```bash
npm test
# or explicitly:
node --test test/unit/*.test.mjs test/integration/*.test.mjs
```

### Run E2E tests (requires live services)

```bash
npm run restart-all   # start all services
npm run test:e2e      # run E2E suite
# or:
node --test test/e2e/*.test.mjs
```

### Run everything

```bash
npm run test:all
```

### Run a single test file

```bash
node --test test/unit/skills-execution.test.mjs
```

### Validate dashboard after changes

```bash
node scripts/check-dashboard.mjs --source-only
```

### Health check

```bash
node scripts/health-check.mjs
```

### Adding tests

- Unit test: add to `test/unit/your-feature.test.mjs` — test pure functions, no services
- Integration test: add to `test/integration/` — test against in-process HTTP or file system
- E2E test: add to `test/e2e/` — mark skips gracefully if services aren't up

Use Node.js built-in test runner:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('my feature', () => {
  it('does the thing', () => {
    assert.equal(myFn('input'), 'expected');
  });
});
```

---

## Pull request checklist

- [ ] `npm test` passes (unit + integration)
- [ ] `node scripts/check-dashboard.mjs --source-only` passes (if you touched dashboard/frontend)
- [ ] No secrets, API keys, or personal paths in the diff
- [ ] `~/.crewswarm/` paths never hardcoded — use `os.homedir()` + `path.join()`
- [ ] New env vars documented in `AGENTS.md` → Environment Variables section
- [ ] New user-facing behaviour documented in `README.md` or `docs/`
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] PR description uses the template (What / Why / How / Test plan)

---

## Commit style

Conventional Commits — imperative subject, 72 chars max:

```
fix: prevent dispatch loop when crew-lead echoes past-tense replies
feat: add Codex CLI as passthrough engine with --full-auto flag
docs: update CONTRIBUTING.md with skill authoring guide
test: add 45 unit tests for Ouroboros engine loop
refactor: extract LLM caller into lib/crew-lead/llm-caller.mjs
```

No ticket numbers required. No emoji in commit messages unless the file already uses them.

---

## Code style

- ESM (`import`/`export`) throughout — no CommonJS `require()`
- Imports at the top of each file — no inline imports mid-function
- No comments that narrate what code does — only explain non-obvious intent or tradeoffs
- `const` over `let`; no `var`
- 2-space indent
- No trailing whitespace

---

## Release process

CrewSwarm uses `main` as the release branch. No versioned npm releases yet — install from source.

1. All PRs merge to `main`
2. `CHANGELOG.md` `[Unreleased]` section is updated with each PR
3. Periodic version bumps: move `[Unreleased]` to a `[0.X.0]` section and create a GitHub Release
4. Smoke CI runs on every PR (`smoke.yml`)

---

## Questions?

Open a [discussion](../../discussions) or a [question issue](../../issues/new?template=question.yml).

You can also ask the crew directly — run `npm run restart-all`, open the dashboard, and ask in the chat.
