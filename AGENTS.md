# CrewSwarm — AI Setup Guide

> This file is read automatically by Cursor, Claude Code, Codex, and most AI coding assistants.
> If a user says "set this up", "install CrewSwarm", or "get me started" — follow the steps below.

## AI Assistant Rules (Cursor / Coding Agent)

- **NEVER modify Stinki's (crew-lead) personality, tone, or character.** The user set it up intentionally. Do not add tone rules, professionalism rules, or behavior softening to `crew-lead.mjs` or `~/.crewswarm/agent-prompts.json` for crew-lead. The only exception is if a tone/personality instruction is actively breaking functional prompt parsing (e.g. causing syntax errors or tool failures).

---

## What is CrewSwarm?

**The multi-agent orchestration layer for OpenCode and Cursor.** CrewSwarm runs a crew of specialist AI agents (coder, QA, PM, fixer, security, copywriter, etc.) that collaborate on tasks via a real-time WebSocket bus. Each agent can be routed through **OpenCode CLI**, **Cursor CLI**, or a direct LLM API call — you pick per agent from the dashboard.

You interact through a web dashboard, Telegram, WhatsApp, or by chatting directly with crew-lead.

### Execution modes (per agent)

| Mode | How it works | Best for |
|---|---|---|
| **OpenCode** | Agent tasks run inside `opencode run` — full file editing, bash, session memory | Coding agents (crew-coder, crew-coder-back, crew-coder-front, crew-fixer) |
| **Cursor CLI** | Agent tasks run via `cursor --model <model> --execute` | Complex reasoning tasks, architect, crew-main |
| **Direct API** | Agent calls the LLM provider directly, parses `@@TOOL` markers | Fast/cheap agents, crew-pm, crew-qa, crew-copywriter |

Switch modes from the **Settings → Agents** tab with the bulk setter buttons, or configure per-agent in `~/.crewswarm/crewswarm.json`.

**Ports when running:**
| Service | Port |
|---|---|
| Dashboard (Vite frontend + API) | 4319 |
| crew-lead (chat + dispatch) | 5010 |
| RT message bus | 18889 |
| Code Engine (OpenCode / Claude Code / Cursor) | 4096 |
| MCP + OpenAI-compatible API (optional) | 5020 |

---

## Setup — do this when the user first opens the repo

### Step 1 — Prerequisites

```bash
node --version   # needs 20+
npm --version
```

If Node.js is missing:
```bash
brew install node   # macOS
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Run the installer

```bash
bash install.sh
```

The installer will:
- Create `~/.crewswarm/` config directory
- Bootstrap `config.json` (RT auth token), `crewswarm.json` (agent models), `cmd-allowlist.json`
- Optionally start all services and open the dashboard in the browser
- Optionally set up SwiftBar menu bar plugin (macOS)
- Optionally set up Telegram bot
- Optionally set up WhatsApp bot

### Step 4 — Add at least one API key

Open the dashboard at `http://127.0.0.1:4319` → **Providers** tab.

**Groq is free and works immediately:** https://console.groq.com/keys

Paste the key next to `groq`. That's enough to run the whole crew.

Other supported providers: Mistral, Cerebras, DeepSeek, Perplexity, OpenAI,
Anthropic, xAI, Google, NVIDIA.

### Step 5 — Start the crew

```bash
npm run restart-all
```

Or from the dashboard → Services tab → Start All.

### Step 6 — Talk to the crew

Open `http://127.0.0.1:4319` → **Chat** tab and start typing.

---

## Key files to know

**Every time you edit `scripts/dashboard.mjs`:** run `node scripts/check-dashboard.mjs` before you're done. Dashboard edits often break the inline script (quotes, template literals); the check shows the exact line that breaks. Run it after every dashboard change — not just before commit. Use `--source-only` if the full check times out.

| File | What it does |
|---|---|
| `crew-lead.mjs` | Conversational commander, HTTP server on :5010 |
| `gateway-bridge.mjs` | Per-agent daemon — calls LLM, executes tools |
| `scripts/dashboard.mjs` | API server on :4319; serves Vite frontend from `frontend/dist`. **UI code is NOT here.** |
| `frontend/index.html` | **Dashboard HTML structure** — tabs, cards, layout. Edit this for UI changes. |
| `frontend/src/app.js` | **Dashboard JavaScript** — all functions, event handlers, API calls. Edit this for UI changes. |
| `frontend/src/styles.css` | **Dashboard CSS** — variables, components, layout. |
| `frontend/dist/` | Built output from `cd frontend && npm run build`. This is what the server serves. |
| `frontend/` | Vite dashboard UI (`npm run build` outputs to `frontend/dist`) |
| `scripts/mcp-server.mjs` | MCP + OpenAI-compatible API on :5020 — exposes agents/skills to Cursor, Claude Code, Open WebUI, etc. **(optional — core stack works without it)** |
| `scripts/check-dashboard.mjs` | Validates dashboard HTML/inline script — **run after editing dashboard.mjs** to avoid breaking the UI |
| `scripts/health-check.mjs` | Fast diagnostic — checks all services, agents, and MCP in one shot |
| `telegram-bridge.mjs` | Telegram integration |
| `whatsapp-bridge.mjs` | WhatsApp integration (personal bot via Baileys — scan QR once) |
| `scripts/crew-scribe.mjs` | Memory maintenance (summaries, lessons) |
| `~/.crewswarm/crewswarm.json` | Agent model assignments + provider API keys |
| `~/.crewswarm/config.json` | RT auth token |
| `~/.crewswarm/agent-prompts.json` | System prompt per agent |

**Crew laws:** `memory/law.md` defines four principles injected into every agent: (1) do not harm the user, (2) no access to personal/private resources without permission, (3) do not break the machine, (4) create value (make the user money or equivalent). See [Laws of robotics](https://en.wikipedia.org/wiki/Laws_of_robotics). Edit `memory/law.md` to tweak.

**How crew-main (or any agent) can see and explain the system:** Agents do not get the full repo in context automatically. To explain how the dashboard, crew-lead, or gateway works: use **@@READ_FILE** on the paths above (e.g. `scripts/dashboard.mjs`, `crew-lead.mjs`, `gateway-bridge.mjs`) and on `AGENTS.md` / `memory/brain.md`. To propose or assign code changes: dispatch to the right specialist (e.g. @@DISPATCH to crew-coder or crew-frontend with a concrete task and file path). The user can then take that plan and have Cursor or another tool apply the edits.

---

## Benchmarks (ZeroEval / llm-stats.com)

LLM leaderboard data from [llm-stats.com](https://llm-stats.com) — compare models on SWE-Bench Verified, LiveCodeBench, MMLU, and more.

- **Dashboard → Benchmarks tab** — pick a benchmark (SWE-Bench Verified, LiveCodeBench, etc.) and view ranked model scores.
- **Skill for agents:** `@@SKILL zeroeval.benchmark {"benchmark_id":"swe-bench-verified"}` or `livecodebench`, `mmlu`, `gpqa`, `humaneval`, `gsm8k`, etc.
- **API proxy** (dashboard): `GET /api/zeroeval/benchmarks` — list benchmarks; `GET /api/zeroeval/benchmarks/{id}` — leaderboard for one benchmark.
- **Source:** `https://api.zeroeval.com/leaderboard/benchmarks/{benchmark_id}` (no auth).

---

## Skill plugins (add skills without custom code)

Skills in `~/.crewswarm/skills/*.json` are **data-driven plugins**. Drop a JSON file and it works — no edits to crew-lead or gateway-bridge.

**Core fields:** `description`, `url`, `method`, `defaultParams`, `paramNotes`

**Optional — discoverable params:**
- `listUrl` — when the main URL's path param is empty, call this instead (e.g. list all).
- `listUrlIdField` — when building health snapshot, fetch listUrl and extract this field from each item → shows "IDs (live): x, y, z" to agents.

**Optional — skill name aliases:**
- `aliases` — `["benchmark", "benchmarks"]` — friendly names that map to this skill. `@@SKILL benchmark {}` resolves to `zeroeval.benchmark`.

**Optional — param normalization:**
- `paramAliases` — `{"paramName": {"wrong-value": "correct-value"}}` — e.g. `{"benchmark_id": {"human-eval": "humaneval"}}`

**Example:** See `skills/zeroeval.benchmark.json`. Install copies from `skills/` to `~/.crewswarm/skills/` (install overwrites bundled skills).

**SKILL.md format (ClawHub-compatible):** Skills can also be a folder with a `SKILL.md` file (YAML frontmatter + body). Drop a `~/.crewswarm/skills/<name>/SKILL.md` folder and it works alongside JSON skills.

**Import from URL (dashboard):** In the **Skills tab → Import URL**, paste any raw URL to a `.json` or `SKILL.md` skill file. GitHub blob URLs are auto-converted to raw. The skill is saved to `~/.crewswarm/skills/` and immediately available to agents.

---

## Roadmap and paths

- **One ROADMAP per project.** Each project has exactly one `ROADMAP.md` at its output directory: `<outputDir>/ROADMAP.md`.
- **Repo root** `ROADMAP.md` = ops/core (CrewSwarm itself). `website/ROADMAP.md` = website project only. Do not assume “ROADMAP.md” without a path means repo root — use the project’s outputDir when given.
- **PM:** When a task says “the roadmap” or “ROADMAP.md”, use the project’s outputDir when given; otherwise repo root = ops/core, `website/ROADMAP.md` = website project.

## Who can write where

| Agent | write_file | mkdir | Notes |
|-------|------------|-------|--------|
| crew-coder, crew-coder-front, crew-coder-back, crew-frontend, crew-fixer | ✓ | ✓ | Full project files |
| crew-copywriter | ✓ | ✓ | Docs, copy, content |
| crew-qa | read-only by default | — | Grant write_file via @@TOOLS if needed |
| crew-pm | ✓ | ✓ | **New projects only:** create folder + ROADMAP.md. For **existing** repo files (e.g. repo root ROADMAP.md) must @@DISPATCH to crew-copywriter or crew-coder with full path and items |
| crew-github | read + run_cmd + git | — | Commits, PRs via git |
| crew-security, crew-main | ✓ | ✓ | Per role defaults |

See `~/.crewswarm/crewswarm.json` → `agents[].tools.crewswarmAllow` to override per agent. Defaults are in `gateway-bridge.mjs` → AGENT_TOOL_ROLE_DEFAULTS.

---

## Agent roster

| Agent ID | Role |
|---|---|
| `crew-coder` | Full-stack coding |
| `crew-coder-front` | Frontend / UI |
| `crew-coder-back` | Backend / API |
| `crew-frontend` | CSS / design |
| `crew-qa` | Testing & audit (report path: crew-lead injects `<projectDir>/qa-report.md` so QA never gets a random path) |
| `crew-fixer` | Bug fixing |
| `crew-pm` | Planning & roadmaps |
| `crew-security` | Security review |
| `crew-copywriter` | Writing & docs |
| `crew-github` | Git & PRs |
| `crew-main` | General purpose |
| `crew-orchestrator` | Parallel wave orchestrator |
| `crew-researcher` | Web research (Perplexity) |
| `crew-architect` | System design / DevOps / infrastructure |
| `crew-seo` | SEO specialist |
| `crew-ml` | Machine learning / AI pipelines |
| `crew-mega` | General purpose heavy tasks |
| `crew-telegram` | Telegram bridge agent |
| `crew-whatsapp` | WhatsApp bridge agent |
| `orchestrator` | Internal pipeline routing (alias for crew-orchestrator) |

---

## Orchestrators and coordinators

- Canonical RT agent IDs live in `lib/agent-registry.mjs` (for example `crew-coder`, `crew-pm`, `orchestrator`).
- Bare aliases (for example `coder`, `pm`) are normalized to canonical RT IDs before dispatch.
- Coordinator IDs that are allowed to emit `@@DISPATCH` are centralized in `lib/agent-registry.mjs` and enforced in `gateway-bridge.mjs`.

### Coordinator responsibilities

- `orchestrator`: PM-loop router and internal orchestration only.
- `crew-pm`: planning worker (task decomposition, roadmap breakdown).
- `crew-main`: general coordinator and final synthesis/verification.

### OpenCode orchestrator roles

- OpenCode `build`: delegation-only build orchestrator.
- OpenCode `orchestrator`: tool-based orchestrator (`code_execute`, `code_validate`, `code_status`).
- CrewSwarm runtime uses `orchestrator` / `crew-pm` / `crew-main` as the main coordination chain.

### PM-loop synthesis → OpenCode

- After the swarm completes roadmap tasks, PM-loop calls **crew-main** for final synthesis (audit + assembly).
- The crew-main daemon is in `OPENCODE_AGENTS` in `gateway-bridge.mjs`, so it routes those tasks to **OpenCode** when `OPENCREW_OPENCODE_ENABLED` is on.
- PM-loop sets `OPENCREW_OPENCODE_PROJECT` to the PM output dir when invoking crew-main; the bridge passes it as `payload.projectDir` so OpenCode runs in the build output directory.

### Ouroboros-style LLM ↔ OpenCode loop

- When an agent has **OpenCode loop** enabled (`opencodeLoop: true` in `crewswarm.json` or `OPENCREW_OPENCODE_LOOP=1`), the gateway runs a multi-step loop instead of a single OpenCode call: the **role’s LLM** is asked for “STEP: &lt;instruction&gt; or DONE”; each STEP is sent to OpenCode as a mini task; results are fed back until the LLM says DONE or `OPENCREW_OPENCODE_LOOP_MAX_ROUNDS` (default 10) is reached. Same idea as [Ouroboros](https://github.com/joi-lab/ouroboros) tool loop, adapted for multi-agent: each agent can run this loop when handling a task.

---

## Agent tools (@@TOOL syntax)

Agents communicate tool calls inline in their replies:

```
@@WRITE_FILE /path/to/file.js
...file contents...
@@END_FILE

@@READ_FILE /path/to/file.js

@@MKDIR /path/to/dir

@@RUN_CMD ls -la
```

`@@RUN_CMD` is gated by `~/.crewswarm/cmd-allowlist.json` and requires dashboard approval for unlisted commands.

---

## Dispatching tasks

From the dashboard chat or Telegram:
```
dispatch crew-coder to write a login endpoint with JWT
have crew-qa audit the last PR
```

Or pipeline multiple agents:
```
@@PIPELINE [
  {"wave":1, "agent":"crew-coder", "task":"Write /src/auth.ts — JWT login"},
  {"wave":2, "agent":"crew-qa",    "task":"Test the auth endpoint"}
]
```

Tasks in the same `wave` run in parallel. Higher waves wait for lower waves.

**Stopping and killing activity:**

| Command | Phrase examples | What it does |
|---|---|---|
| `@@STOP` | "stop everything", "emergency stop", "pause all" | Cancels all pipelines instantly. Signals PM loops to halt **after their current task**. Clears autonomous mode. Agent bridges stay up. |
| `@@KILL` | "kill everything", "kill all agents", "nuke it" | Everything `@@STOP` does + **SIGTERMs all agent bridge processes and PM loop processes immediately**. Use when agents are stuck or looping. Bridges must be restarted after (`@@SERVICE restart agents` or Services tab). |

In-flight tasks already dispatched to agents cannot be recalled by either command — they run to completion or hit timeout. Use the **Services tab → ⏹ Stop** to hard-kill individual services (dashboard, Code Engine, MCP, etc.).

---

## External API (for integrations)

crew-lead exposes a REST API for external tools. Auth: Bearer token from `~/.crewswarm/config.json → rt.authToken`.

```bash
TOKEN=$(cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")

# List agents
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/agents

# Dispatch a task
curl -X POST http://127.0.0.1:5010/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crew-coder","task":"write hello.js"}'

# Poll for result
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/status/<taskId>

# Who is currently in an OpenCode session (live)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/agents/opencode

# All agents with live OpenCode status (inOpenCode, openCodeSince, openCodeModel)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/agents

# Today's token usage + cost per agent
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/api/spending
```

---

## Common commands

```bash
npm run restart-all          # restart everything
node scripts/start-crew.mjs  # restart just the agent bridges
node crew-lead.mjs           # restart just crew-lead

# Check logs
tail -f /tmp/crew-lead.log
tail -f /tmp/opencrew-rt-daemon.log
```

### Background consciousness (optional, Ouroboros-style)

When enabled, **crew-main** is periodically given a short "reflect between tasks" cycle when no pipelines are running: it reads `memory/brain.md`, considers follow-ups and system health, and can emit one `@@BRAIN:` or `@@DISPATCH` or reply `NO_ACTION`. Keeps the crew proactive and lets crew-main **manage the process for the user**.

- **Enable:** `CREWSWARM_BG_CONSCIOUSNESS=1` (or `true`/`yes`) when starting crew-lead. Optional: `CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS=900000` (default 15 min).
- **Example:** `CREWSWARM_BG_CONSCIOUSNESS=1 node crew-lead.mjs`
- Runs only when there are no active pipelines; throttle respects the interval.
- **User visibility:** crew-main’s background reply is appended to the **owner** chat as `[crew-main — background]: …` and written to **`~/.crewswarm/process-status.md`** so the user (or a dashboard) can see current status, suggested next steps, and any follow-up actions.
- **Cheap model (recommended):** If a **Groq** API key is in `~/.crewswarm/crewswarm.json` under `providers.groq`, the background cycle uses a **direct Groq call** instead of dispatching to crew-main — super cheap and fast. Default model: `groq/llama-3.1-8b-instant`. Override with `CREWSWARM_BG_CONSCIOUSNESS_MODEL=groq/llama-3.3-70b-versatile` (or any `provider/model` from your config). If no Groq (or chosen provider) is configured, crew-lead falls back to dispatching the cycle to **crew-main** (uses his model).

---

## Scheduled pipelines (cron)

Run a **workflow** (agents + tasks per stage) or a **skill-only** pipeline on a schedule. No daemon — cron runs the script.

### Workflow (agent + task per stage)

Pick the agent and what they should do in each stage. Stages run in order; each stage’s reply is passed to the next as `[Previous step output]`. Optional `tool` is for your own note (e.g. which capability that stage uses).

Create `~/.crewswarm/pipelines/<name>.json`:

```json
{
  "stages": [
    { "agent": "crew-copywriter", "task": "Draft a 280-char tweet about our launch. Write the final tweet to /tmp/cron-tweet.txt and reply with the text.", "tool": "write_file" },
    { "agent": "crew-main", "task": "Read /tmp/cron-tweet.txt and post it using @@SKILL twitter.post with that text. Reply when done.", "tool": "skill" }
  ]
}
```

Requires crew-lead and the RT bus (so dispatch returns a taskId for polling). Agents must be running (e.g. `npm run start-crew`).

### Skill-only pipeline (no agents)

If you only need to call skills in sequence (no agent tasks), use `steps`:

```json
{
  "steps": [
    { "skill": "twitter.post", "params": { "text": "Daily update: …" } },
    { "skill": "polymarket.trade", "params": { } }
  ]
}
```

### Run from cron

```bash
# Run workflow or skill pipeline by name
node scripts/run-scheduled-pipeline.mjs social

# Run a single skill with inline params
node scripts/run-scheduled-pipeline.mjs --skill twitter.post --params '{"text":"Hello from cron"}'
```

**Crontab example** (daily at 9am; create `~/.crewswarm/logs` first):

```bash
0 9 * * * cd /path/to/CrewSwarm && node scripts/run-scheduled-pipeline.mjs social >> ~/.crewswarm/logs/cron.log 2>&1
```

crew-lead must be running (port 5010). Auth: `~/.crewswarm/config.json` → `rt.authToken`.

---

## Customizing the crew

### Change an agent's model

Edit `~/.crewswarm/crewswarm.json`:

```json
{ "id": "crew-coder", "model": "anthropic/claude-sonnet-4-5" }
```

Format is always `provider/model-id`. Provider must have an API key in the `providers` block of the same file.

To enable the **Ouroboros-style LLM ↔ OpenCode loop** for an agent (LLM decomposes task into steps, each step run by OpenCode, until DONE), set `opencodeLoop: true` for that agent in `crewswarm.json`, or set env `OPENCREW_OPENCODE_LOOP=1` for all. Optional: `OPENCREW_OPENCODE_LOOP_MAX_ROUNDS` (default 10).

### Change an agent's system prompt

Edit `~/.crewswarm/agent-prompts.json`. The key is the bare agent name without `crew-` prefix:

```json
{ "coder": "You are crew-coder. Your rules: ..." }
```

Restart the agent bridge for the change to take effect:
```bash
pkill -f "gateway-bridge.mjs"
node scripts/start-crew.mjs
```

### Add a new agent

1. Add an entry to `~/.crewswarm/crewswarm.json`:
```json
{ "id": "crew-researcher", "model": "perplexity/sonar-pro" }
```

2. Add a system prompt to `~/.crewswarm/agent-prompts.json`:
```json
{ "researcher": "You are crew-researcher. Search the web and summarize findings..." }
```

3. Restart bridges — the new agent is auto-registered.

### Change tool permissions per agent

In `~/.crewswarm/crewswarm.json`, add a `crewswarmAllow` field:

```json
{
  "id": "crew-researcher",
  "model": "perplexity/sonar-pro",
  "tools": {
    "crewswarmAllow": ["read_file", "write_file"]
  }
}
```

Available permissions: `read_file`, `write_file`, `mkdir`, `run_cmd`, `git`, `dispatch`.
If omitted, role defaults apply (coders get read/write/mkdir/run, others get read-only).

### Add a provider

In `~/.crewswarm/crewswarm.json` under `providers`:

```json
{
  "providers": {
    "my-provider": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.my-provider.com/v1"
    }
  }
}
```

Then use `my-provider/model-name` in any agent's `model` field.

---

## WhatsApp bridge — how to set up

Personal bot approach using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web automation). Your phone number becomes a linked device — no Business API or Meta approval needed.

**Start the bridge:**
```bash
npm run whatsapp
# or: node whatsapp-bridge.mjs
```

On first run a QR code prints to the terminal. Open WhatsApp on your phone → **Linked Devices → Link a Device** and scan it. Auth persists in `~/.crewswarm/whatsapp-auth/` — no re-scan after restart.

**Restrict who can message the bot (recommended):**

In `~/.crewswarm/crewswarm.json` `env` block:
```json
"WA_ALLOWED_NUMBERS": "+15551234567,+15559876543"
```
Numbers in international format. Leave empty to allow any sender.

**Commands (same as Telegram):**
```
/projects           — list registered projects
/project <name>     — set active project context
/home               — clear active project
/status             — show bridge status
```

**Logs:** `~/.crewswarm/logs/whatsapp-bridge.jsonl` and `whatsapp-messages.jsonl`

**Note on stability:** Baileys reverse-engineers the WhatsApp Web protocol. It can break after WhatsApp updates. For production use, prefer the official WhatsApp Business API. For personal assistant / home automation use, Baileys is the right choice.

---

## MCP Integration — use your crew from any AI tool

CrewSwarm runs a built-in **MCP server on port 5020**. Connect it to Cursor, Claude Code, OpenCode, or any MCP-compatible client and your full 20-agent crew becomes available as callable tools — from any project, not just the CrewSwarm repo.

### What's exposed (13 MCP tools)

| Tool | What it does |
|---|---|
| `dispatch_agent` | Send a task to any specialist agent and get the result |
| `list_agents` | List all agents, models, and live status |
| `run_pipeline` | Multi-agent pipeline — each stage passes output to the next |
| `chat_stinki` | Talk directly to crew-lead (roadmaps, questions, dispatch) |
| `crewswarm_status` | Live status of all agents + recent task telemetry |
| `smart_dispatch` | Analyze a task → get a multi-agent plan before executing |
| `skill_*` | Run any installed skill (ElevenLabs TTS, Fly deploy, Twitter, etc.) |

### Why this is different from built-in Cursor subagents

| Cursor built-in | CrewSwarm via MCP |
|---|---|
| Session-scoped, die when chat closes | Persistent daemons running 24/7 |
| No memory between sessions | brain.md, lessons, decisions persist forever |
| Generic role descriptions | Your custom crew — names, rules, specialized prompts |
| One model per subagent type | Each agent uses YOUR configured model |
| No cross-agent coordination | RT bus — agents dispatch to each other |

### Setup (automatic)

Run `bash install.sh` and choose **yes** at the MCP integration prompt. It writes `mcp.json` for Cursor, Claude Code, and OpenCode automatically.

### Setup (manual)

Add to `~/.cursor/mcp.json` (same format for `~/.claude/mcp.json` and `~/.config/opencode/mcp.json`):

```json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": {
        "Authorization": "Bearer <your-rt-auth-token>"
      }
    }
  }
}
```

Find your auth token: `cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])"`

Restart your editor after adding the config. The MCP server must be running (`npm run restart-all`).

### OpenAI-compatible API (bonus)

The same port also exposes an OpenAI-compatible API — use it with Open WebUI or any tool that accepts a custom base URL:

```
Base URL: http://127.0.0.1:5020/v1
API key:  (any string)
Models:   one per agent (crew-coder, crew-qa, etc.)
```

---

## crew-github — what it needs

crew-github runs real `git` and `gh` commands via `@@RUN_CMD`. For it to work:

**Required (commits + push):**
```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
# Plus SSH key or HTTPS credentials for your GitHub account
```

**Required for PRs and issues (`gh` CLI):**
```bash
gh auth login   # follow prompts — authenticates gh with GitHub
```

**No special API key needed** — it uses your local git credentials, same as you would from the terminal. It cannot push to repos you don't have access to.

---

## MCP Integration — use CrewSwarm agents in any project

CrewSwarm runs an MCP server on port **5020**. Wire it into Cursor, Claude Code, or OpenCode and all 20 agents become available as callable tools in any project — no AGENTS.md copy needed.

**Auto-setup (recommended):** run `bash install.sh` and answer `y` to the MCP prompt. It configures all three tools automatically.

**Manual setup:** get your auth token, then add the crewswarm entry to each tool's MCP config:

```bash
TOKEN=$(node -e "const c=require('fs').readFileSync(require('os').homedir()+'/.crewswarm/config.json','utf8');console.log(JSON.parse(c).rt?.authToken)")
```

**Cursor** — `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "crewswarm": {
      "url": "http://127.0.0.1:5020/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```
Restart Cursor after saving.

**Claude Code** — `~/.claude/mcp.json`: same format as above.

**OpenCode** — `~/.config/opencode/mcp.json`: same format as above.

Once configured, agents appear as MCP tools. The MCP server must be running (`npm run restart-all` starts it on :5020).

---

## Troubleshooting

**Agents not responding** — run `npm run restart-all`, check logs in `/tmp/`.

**No API key error** — open dashboard → Providers tab, add a Groq key (free).

**crew-lead not reachable** — `curl http://127.0.0.1:5010/health` — if 404, restart with `node crew-lead.mjs`.

**File not written by agent** — agent's tool permissions come from `~/.crewswarm/crewswarm.json → agents[].tools.crewswarmAllow` or role defaults in `gateway-bridge.mjs → AGENT_TOOL_ROLE_DEFAULTS`.
