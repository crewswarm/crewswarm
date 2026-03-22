# Contributing to crewswarm

Thanks for your interest. crewswarm is an active project and contributions are welcome -- bug fixes, new skills, agent improvements, engine integrations, and docs all matter.

---

## Development setup

```bash
# 1. Clone the repo
git clone https://github.com/crewswarm/crewswarm.git
cd crewswarm

# 2. Install dependencies and bootstrap config
npm install
bash install.sh

# 3. Start all services
npm run restart-all

# 4. Verify
open http://127.0.0.1:4319   # Dashboard UI
curl http://127.0.0.1:5010/health  # crew-lead API
```

You need at least one LLM API key to run the crew. Groq is free: https://console.groq.com/keys

Configuration lives in `~/.crewswarm/`. The installer creates it if missing.

---

## Project structure

| Path | What lives here |
|---|---|
| `crew-lead.mjs` | Conversational commander + HTTP API (port 5010) |
| `gateway-bridge.mjs` | Per-agent daemon -- LLM calls, tool execution, engine routing |
| `lib/crew-lead/` | Chat handler, wave dispatcher, LLM caller, prompts, HTTP server |
| `lib/engines/` | Engine runners (Cursor CLI, Claude Code, Gemini CLI, Codex), Ouroboros loop |
| `lib/pipeline/` | Project draft/confirm, roadmap AI generation |
| `lib/skills/` | Skill loader -- handles both `.json` API skills and `SKILL.md` knowledge skills |
| `lib/tools/` | `@@TOOL` marker parser and executor |
| `apps/dashboard/` | Vite dashboard UI -- edit `apps/dashboard/src/`, build with `npm run build` |
| `apps/vibe/` | Vibe standalone app |
| `crew-cli/` | CLI tool integrations and external engine bridges |
| `scripts/` | Dashboard API server (`dashboard.mjs`), smoke tests, utility scripts |
| `pm-loop.mjs` | Autonomous PM loop -- reads ROADMAP.md, dispatches items |
| `skills/` | Bundled skill plugins shipped with the repo |
| `~/.crewswarm/skills/` | User-installed skills (JSON + SKILL.md) |
| `memory/` | Shared agent context (brain.md, laws, lessons) |
| `test/unit/` | Unit tests -- no services needed |
| `test/integration/` | Integration tests -- no services needed |
| `test/e2e/` | E2E tests -- require `npm run restart-all` first |
| `docs/` | Architecture, orchestration guides, troubleshooting |

---

## Running tests

### Unit + integration tests (no services needed)

```bash
npm test
# or explicitly:
node --test test/unit/*.test.mjs test/integration/*.test.mjs
```

### E2E tests (requires live services)

```bash
npm run restart-all   # start all services
npm run test:e2e      # run E2E suite
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

---

## How to add a new agent

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

4. Restart bridges -- the new agent auto-registers on the RT bus:
```bash
node scripts/start-crew.mjs
```

---

## How to add a new engine

Engines live in `lib/engines/`. Each engine module exports a `run()` function that receives a task and returns results.

1. Create `lib/engines/my-engine.mjs`:
```js
import { spawn } from 'node:child_process';

export async function run(task, opts = {}) {
  // Spawn the CLI tool, pass the task prompt, collect output
  // Return { output, exitCode }
}
```

2. Register it in `lib/engines/engine-registry.mjs` by adding an entry mapping the engine name to the runner module.

3. Add tests in `test/unit/my-engine.test.mjs`.

4. Document the engine and any required CLI tools in `AGENTS.md`.

---

## Making changes

### Frontend (dashboard UI)

The UI lives in `apps/dashboard/` -- **not** `scripts/dashboard.mjs`. The dashboard script is the API backend.

```bash
# 1. Edit apps/dashboard/index.html, apps/dashboard/src/app.js, or apps/dashboard/src/styles.css
# 2. Build
cd apps/dashboard && npm run build
# 3. Restart dashboard
pkill -f "dashboard.mjs" && node scripts/dashboard.mjs &
# 4. Validate (run after every dashboard change)
node scripts/check-dashboard.mjs --source-only
```

### Backend (crew-lead, gateway-bridge)

Plain ESM Node.js -- no build step. Restart the affected process:

```bash
# crew-lead
pkill -f "crew-lead.mjs" && node crew-lead.mjs &

# All agent bridges
pkill -f "gateway-bridge.mjs" && node scripts/start-crew.mjs

# Single bridge (e.g. crew-coder)
pkill -f "crew-coder" && node gateway-bridge.mjs crew-coder &
```

### Adding a knowledge skill (SKILL.md -- no code)

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
Content here -- frameworks, checklists, decision trees.

## Section 2
More content.
EOF
```

The skill is immediately available -- no restart needed. Test it: `@@SKILL my-skill {}` in the dashboard chat.

### Adding an API skill (JSON -- calls an external endpoint)

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

Or use the dashboard Skills tab and the **+ New API Skill** form.

---

## Code style

- ES modules (`import`/`export`) throughout -- no CommonJS `require()`
- `async`/`await` for all asynchronous operations -- no callbacks
- Imports at the top of each file -- no inline imports mid-function
- No comments that narrate what code does -- only explain non-obvious intent or tradeoffs
- `const` over `let`; no `var`
- 2-space indent
- No trailing whitespace

---

## Commit style

Conventional Commits -- imperative subject, 72 chars max:

```
fix: prevent dispatch loop when crew-lead echoes past-tense replies
feat: add Codex CLI as passthrough engine with --full-auto flag
docs: update CONTRIBUTING.md with skill authoring guide
test: add 45 unit tests for Ouroboros engine loop
refactor: extract LLM caller into lib/crew-lead/llm-caller.mjs
```

No ticket numbers required. No emoji in commit messages unless the file already uses them.

---

## Pull request process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes with clear, atomic commits.
3. Run `npm test` and make sure all tests pass.
4. If you touched the dashboard, run `node scripts/check-dashboard.mjs --source-only`.
5. Open a PR against `main` with a description covering: What / Why / How / Test plan.
6. Address review feedback. PRs require passing CI before merge.

### PR checklist

- [ ] `npm test` passes (unit + integration)
- [ ] `node scripts/check-dashboard.mjs --source-only` passes (if you touched dashboard/frontend)
- [ ] No secrets, API keys, or personal paths in the diff
- [ ] `~/.crewswarm/` paths never hardcoded -- use `os.homedir()` + `path.join()`
- [ ] New env vars documented in `AGENTS.md`
- [ ] New user-facing behaviour documented in `README.md` or `docs/`
- [ ] `CHANGELOG.md` updated under `[Unreleased]`

---

## Good first issues

These are concrete starter tasks for new contributors:

- **Add a new skill to `~/.crewswarm/skills/`** -- Write a SKILL.md knowledge playbook for a domain you know (deployment checklists, code review guides, security audits).
- **Improve an agent's system prompt** -- Refine the prompt in `~/.crewswarm/agent-prompts.json` for an existing agent to handle edge cases better.
- **Add unit tests for an untested module** -- Pick a file in `lib/` that lacks test coverage and add tests using Node.js built-in test runner.
- **Add a new LLM provider integration** -- Wire up a new provider (Mistral, Cohere, local Ollama) in the engine registry.
- **Improve dashboard UI** -- Dark mode polish, responsive layout fixes, accessibility improvements in `apps/dashboard/`.
- **Add a new CLI engine bridge** -- Integrate a new coding CLI tool in `lib/engines/` following the existing runner pattern.
- **Documentation improvements** -- Fix gaps in README, AGENTS.md, or docs/ guides. Add examples, clarify setup steps.

Check the [issue tracker](../../issues?q=label%3A%22good+first+issue%22) for tagged issues too.

---

## Adding tests

- **Unit test**: add to `test/unit/your-feature.test.mjs` -- test pure functions, no services
- **Integration test**: add to `test/integration/` -- test against in-process HTTP or file system
- **E2E test**: add to `test/e2e/` -- mark skips gracefully if services are not up

Use the Node.js built-in test runner:

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

## Release process

crewswarm uses `main` as the release branch. No versioned npm releases yet -- install from source.

1. All PRs merge to `main`.
2. `CHANGELOG.md` `[Unreleased]` section is updated with each PR.
3. Periodic version bumps: move `[Unreleased]` to a `[0.X.0]` section and create a GitHub Release.
4. Smoke CI runs on every PR (`smoke.yml`).

---

## Questions?

Open a [discussion](../../discussions) or a [question issue](../../issues/new?template=question.yml).

You can also ask the crew directly -- run `npm run restart-all`, open the dashboard, and ask in the chat.
