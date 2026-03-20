# crewswarm — AI Setup Guide

> This file is read automatically by Cursor, Claude Code, Codex, and most AI coding assistants.
> If a user says "set this up", "install crewswarm", or "get me started" — follow the steps below.

## Canonical Docs TOC

Start here. Treat this section and `docs/CANONICAL/` as the current source of truth.

- `README.md` — public overview and quickstart
- `docs/README.md` — docs index: canonical vs legacy
- `docs/CANONICAL/README.md` — canonical docs map
- `docs/CANONICAL/ROUTING.md` — shared chat, mentions, dispatch, thread continuity
- `docs/CANONICAL/RUNTIME.md` — engines, agent execution paths, runtime identity
- `docs/CANONICAL/CURSOR-CLI.md` — Cursor `agent` CLI, Keychain/auth, `CURSOR_API_KEY`
- `docs/CANONICAL/MEMORY.md` — shared memory, project messages, RAG role
- `docs/CANONICAL/TESTING.md` — smoke tests, regression coverage, verification rules

## Legacy Note

Most of the rest of this file is legacy setup/reference material kept for compatibility during cleanup. Prefer the TOC above first. If this file conflicts with `docs/CANONICAL/`, the canonical docs win.

## AI Assistant Rules (Cursor / Coding Agent)

- **NEVER modify Stinki's (crew-lead) personality, tone, or character.** The user set it up intentionally. Do not add tone rules, professionalism rules, or behavior softening to `crew-lead.mjs` or `~/.crewswarm/agent-prompts.json` for crew-lead. The only exception is if a tone/personality instruction is actively breaking functional prompt parsing (e.g. causing syntax errors or tool failures).

- **🚨 CRITICAL: NEVER overwrite large files entirely.** When editing files > 100 lines, you MUST use StrReplace (or equivalent targeted edit tool) with 5-10 lines of context before and after the change. NEVER use Write/overwrite on existing files > 100 lines. Protected files that must NEVER be overwritten: `gateway-bridge.mjs` (1,720 lines), `crew-lead.mjs` (1,800+ lines), `scripts/dashboard.mjs` (4,600+ lines). **Real incident (March 4, 2026):** AI assistant destroyed `gateway-bridge.mjs` (1,720 lines → 2 lines), crashed all 20 agents, required git recovery. See `.cursor/rules/never-overwrite-large-files.mdc` for full protocol.

---

## What is crewswarm?

**The multi-agent orchestration layer for OpenCode and Cursor.** crewswarm runs a crew of specialist AI agents (coder, QA, PM, fixer, security, copywriter, etc.) that collaborate on tasks via a real-time WebSocket bus. Each agent can be routed through **OpenCode CLI**, **Cursor CLI**, or a direct LLM API call — you pick per agent from the dashboard.

You interact through a web dashboard, Telegram, WhatsApp, or by chatting directly with crew-lead.

### Execution modes (per agent)

| Mode | How it works | Best for |
|---|---|---|
| **OpenCode** | Agent tasks run inside `opencode run` — full file editing, bash, session memory | Coding agents (crew-coder, crew-coder-back, crew-coder-front, crew-fixer) |
| **Cursor CLI** | Agent tasks run via Cursor `agent` CLI with `--model` (default **`composer-2-fast`**; set `cursorCliModel` per agent or `CREWSWARM_CURSOR_MODEL`) | Complex reasoning tasks, architect, crew-main |
| **Claude Code** | Agent tasks run via `claude -p` — full workspace context, native tool use, session continuity | Large refactors, multi-file reasoning, crew-coder |
| **crew-cli** | Agent tasks run via `codex exec --sandbox workspace-write --json` — OpenAI Codex with full file write access | Coding agents that prefer OpenAI models; compatible with any agent |
| **Direct API** | Agent calls the LLM provider directly, parses `@@TOOL` markers | Fast/cheap agents, crew-pm, crew-qa, crew-copywriter |

Switch modes from the **Settings → Engines** tab with the bulk setter buttons, or configure per-agent in `~/.crewswarm/crewswarm.json`.

### Shared chat participants

In shared chat surfaces (Dashboard Swarm Chat, shared `projectId` rooms, and any MCP client using the chat tools), autonomous `@mentions` can route to both crewswarm agents and CLI participants.

- **Agents:** `@crew-coder`, `@crew-qa`, `@crew-pm`, any canonical `crew-*` agent ID
- **CLI participants:** `@codex`, `@cursor`, `@claude`, `@opencode`, `@gemini`, `@crew-cli`

These mentions are part of the shared coordination plane. Participants can hand work off by mentioning another participant in-channel, and direct engine passthrough remains available separately when you want to talk straight to one CLI.

**Ports when running:**
| Service | Port |
|---|---|
| Dashboard (Vite frontend + API) | 4319 |
| **crewswarm Studio (optional)** | 3333 |
| crew-lead (chat + dispatch) | 5010 |
| RT message bus | 18889 |
| Code Engine (OpenCode / Claude Code / Cursor) | 4096 |
| MCP + OpenAI-compatible API (optional) | 5020 |

---

## Deployment Options

crewswarm supports three deployment methods:

### Option 1: Docker (Recommended for Servers & Teams) 🐳

**One-line install on any Linux machine:**

```bash
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

**Or use Docker Compose manually:**

```bash
git clone https://github.com/crewswarm/crewswarm.git
cd crewswarm
docker compose up -d
```

**Pre-built images available:**

```bash
# Docker Hub
docker pull crewswarm/crewswarm:latest

# GitHub Container Registry
docker pull ghcr.io/crewswarm/crewswarm:latest
```

**Perfect for:**
- ✅ Dedicated agent servers (team shared instances)
- ✅ Cloud VMs (AWS, GCP, DigitalOcean, Azure)
- ✅ Home/edge servers (Raspberry Pi 4/5, NUCs)
- ✅ CI/CD integration (GitHub Actions, GitLab CI)
- ✅ Multi-arch: AMD64 + ARM64 (Apple Silicon, Graviton)

**Documentation:** [docs/docker.md](docs/docker.md)

---

### Option 2: Local Development Setup (Recommended for Contributors)

For local development, hacking on crewswarm itself, or custom engine integrations.

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

**Option 1: Dashboard** (management + config)
Open `http://127.0.0.1:4319` → **Chat** tab and start typing.

**Option 2: Vibe** (full IDE) 🆕
```bash
bash start-studio.sh
# Opens http://127.0.0.1:3333
```

**Full-screen IDE with Monaco editor + agent chat** — Cursor-style layout with file tree, editor, chat panel, and terminal. `npm run restart-all` now starts Vibe + file watcher automatically. See `STUDIO-SETUP-COMPLETE.md` for details.

**Option 3: CrewChat.app** (native macOS)

**✨ New: Multimodal Support**

All platforms now support image recognition and voice transcription:

- **Dashboard**: Click 📷 to upload images, 🎤 to record voice messages
- **Vibe (Studio)**: Full coding environment with agent chat sidebar — drag/drop images, Ctrl/Cmd+V paste, or click 📷 to attach up to 3 images per message
- **crew-cli**: `crew chat --image photo.png "What is this?"` or `/image path.png` in REPL mode — works with Gemini, Anthropic, and OpenAI vision models
- **Telegram**: Send photos or voice notes → bot analyzes/transcribes automatically
- **WhatsApp**: Send images or audio → bot handles media
- **CrewChat.app v2.0**: Native macOS app with two modes:
  - **⚡️ Quick Mode**: Chat with crew-lead (conversational, AI-routed)
  - **🔧 Advanced Mode**: Direct access to specialists (crew-coder, crew-qa, crew-pm, etc.)
  - Per-agent + per-project chat history isolation
  - Engine visibility (OpenCode/Cursor CLI/Claude Code/Direct API)
  - Native image picker + AVFoundation voice recording
  - Build: `./build-crewchat.sh` (takes ~2 min with optimizations)
  - Launch: `open -a CrewChat`

**Providers**: Groq (fast/cheap) or Gemini 2.0 Flash (best quality). Auto-selects based on API keys.

**Cost**: ~$3/month for typical usage (100 images + 1hr audio/day on Groq).

### crew-cli — Standalone Agentic CLI

**`crew-cli/`** is a full-featured TypeScript agentic CLI comparable to Claude Code, Codex CLI, or Gemini CLI:

- **34+ built-in tools**: File I/O, bash, glob/grep, LSP integration, git operations, web search, Docker sandbox, semantic code search (RAG)
- **Multi-provider**: Gemini, OpenAI, Anthropic, xAI, DeepSeek — auto-detects available API keys
- **Multimodal vision**: `--image` flag or `/image` REPL command — images sent as proper content parts
- **Agent memory**: MemoryBroker integration for persistent context across sessions
- **3-layer executor**: L1 (direct tool calls) → L2 (agentic CoT loop, up to 25 iterations) → L3 (fallback providers)
- **REPL mode**: `crew chat` for interactive sessions with `/image`, `/tools`, `/model`, `/clear` commands
- **CI auto-fix**: `crew exec "fix lint errors" --ci` for headless operation

```bash
# Interactive chat
crew chat

# One-shot execution
crew exec "refactor auth module"

# With image attachment
crew chat --image screenshot.png "What's wrong with this UI?"

# CI mode
crew exec "fix all TypeScript errors" --ci
```

See `CREWCHAT-QUICKSTART.md` for CrewChat v2.0 usage guide.  
See `MULTIMODAL-TAB-UI-COMPLETE.md` for full multimodal setup and API reference.  
See `STUDIO-SETUP-COMPLETE.md` for crewswarm Studio IDE guide.

---

## Chat History Persistence & RAG Integration

**All project chat messages persist across tab switches and auto-index for semantic search.**

When you chat with agents in a project:
- ✅ Messages saved to `~/.crewswarm/project-messages/{projectId}/messages.jsonl`
- ✅ **Auto-indexed into local RAG** (TF-IDF + cosine similarity, no API calls)
- ✅ **Cache headers prevent stale data** when switching tabs
- ✅ Agents can search: "What did we discuss about authentication?"

**Sources included:**
- 💻 Dashboard chat (crew-lead)
- ⚡ CLI commands (`crew chat`, `crew exec`)
- 👷 Sub-agent completions (crew-coder, crew-pm, etc.)

**API endpoints:**
```bash
# Load messages
GET /api/crew-lead/project-messages?projectId=my-project

# Semantic search
GET /api/crew-lead/search-messages-semantic?projectId=my-project&q=authentication

# Export (markdown, json, csv, txt)
GET /api/crew-lead/export-project-messages?projectId=my-project&format=markdown
```

**No configuration needed** - messages auto-save and auto-index as you chat!

See `CHAT-HISTORY-AND-RAG-COMPLETE.md` for complete guide (architecture, API reference, troubleshooting).

---

## Shared Memory — unified knowledge across all agents and CLIs

**Every agent, CLI, and session now shares the same memory store.** No more context loss between Cursor sessions, CLI runs, or dashboard chats.

### Three memory layers

1. **AgentMemory** — cognitive facts (decisions, constraints, preferences)
   - Stored in: `~/.crewswarm/shared-memory/.crew/agent-memory/<agent-id>.json`
   - Written by: `@@BRAIN` commands, migration script, `rememberFact()` API
   - Example: "Use bcrypt for password hashing", "Requires 2FA for admin routes"

2. **AgentKeeper** — task results (completed work by all agents)
   - Stored in: `~/.crewswarm/shared-memory/.crew/agentkeeper.jsonl`
   - Written by: Gateway after task completion, CLI `--keep` mode
   - Example: Task "Write auth endpoint" → Result "Created src/api/auth.ts with JWT..."

3. **Collections** — local docs/code RAG (optional, future)
   - Stored in: `~/.crewswarm/shared-memory/.crew/collections/`
   - Written by: `crew index --docs`, `crew index --code`
   - Example: Indexed README.md, API docs, architecture guides

**MemoryBroker** blends all three, scores hits, returns unified context.

### Migrate legacy brain.md (one-time)

```bash
# Preview what will migrate
node scripts/migrate-brain-to-shared-memory.mjs --dry-run

# Perform migration (imports memory/brain.md + memory/lessons.md)
node scripts/migrate-brain-to-shared-memory.mjs
```

After migration: `@@MEMORY stats` shows 200+ facts available to all agents.

### Use shared memory

**From dashboard chat:**
```
@@MEMORY search "authentication security"
@@MEMORY stats
@@BRAIN This project requires 2FA for admin routes
```

**From Cursor/Claude Code:** Just dispatch tasks normally — agents recall shared memory automatically.

**From CLI:** Run `cd crew-cli && npm run build` first, then all CLI commands (`crew chat`, `crew exec`) use shared memory.

**Dashboard Memory tab:** Open `http://127.0.0.1:4319` → **Memory** → view stats, search, migrate, compact.

### How it works

- **Gateway (`gateway-bridge.mjs`):** Calls `recallMemoryContext()` when building agent prompts; records completed tasks via `recordTaskMemory()`
- **Crew-lead chat (`chat-handler.mjs`):** Injects MemoryBroker context at session start; parses `@@MEMORY` commands
- **CLI (`crew chat`, `crew exec`):** Uses MemoryBroker natively (built-in to crew-cli)
- **MCP (Cursor/Claude Code):** crew-lead agent sees shared memory via same chat handler

**Cross-system example:** User stores a fact in Cursor via `@@BRAIN` → Gateway recalls it when dispatching to crew-coder → CLI sees it in next `crew chat` session. Zero duplication, zero sync lag.

See `SHARED-MEMORY-INTEGRATION.md` for full architecture and API reference.

---

## Universal Cross-Platform Systems — NEW (March 2026)

**WhatsApp and Telegram bridges now share unified systems for contacts, preferences, and RAG search.**

### 1. Generic Collections (RAG Search)

**File:** `lib/collections/index.mjs`

TF-IDF + cosine similarity search over any structured data. Use for venues, projects, documentation, tools, etc.

```javascript
import { createCollection } from './lib/collections/index.mjs';

const venues = createCollection('venues');
venues.add({
  title: "Thai Basil Kitchen",
  content: "Pad Thai $14, Green Curry $16...",
  metadata: { cuisine: "Thai", price: "$$", dietary_options: ["vegan"] },
  tags: ["waterfront", "family-friendly"]
});

// Search with filters
const results = venues.search("spicy curry", {
  tags: "vegan",
  exclude: { allergen_warnings: ["shellfish"] }
}, 5);
```

**Legacy script:** archived under `docs/archive/legacy-tests/root/test-collections.mjs`

### 2. Universal Contacts System

**File:** `lib/contacts/index.mjs`

Platform-agnostic user profiles for WhatsApp, Telegram, Slack, Web, iOS.

```javascript
import { trackContact, getContact, updatePreferences } from './lib/contacts/index.mjs';

// Track contact (auto-creates or updates)
trackContact('whatsapp:13109050857@s.whatsapp.net', 'whatsapp', 'STOS', {
  phone: '+13109050857'
});

// Update preferences
updatePreferences('whatsapp:13109050857@s.whatsapp.net', {
  diet: "vegan",
  allergies: ["shellfish"],
  favCuisines: ["Thai", "Mexican"]
});

// Get contact with preferences
const contact = getContact('whatsapp:13109050857@s.whatsapp.net');
```

**Database:** `~/.crewswarm/contacts.db`  
**Legacy script:** archived under `docs/archive/legacy-tests/root/test-contacts.mjs`

### 3. Preference Extraction

**File:** `lib/preferences/extractor.mjs`

Automatic LLM-powered extraction of user preferences from conversation history.

```javascript
import { extractPreferences, shouldExtract } from './lib/preferences/extractor.mjs';

// Extract preferences from conversation
const prefs = await extractPreferences(history, llmCaller, 'food');
// Returns: { diet: "vegan", allergies: ["shellfish"], favCuisines: ["Thai"] }

// Auto-trigger detection
if (shouldExtract(messageCount, latestMessage)) {
  // Extract and save preferences
}
```

**Domains:** `food` (GrabLoco), `work` (crewswarm), `generic`  
**Triggers:** Every 10 messages or preference keywords detected

### 4. Both Bridges Integrated

**WhatsApp:** `whatsapp-bridge.mjs`  
**Telegram:** `telegram-bridge.mjs`

Both bridges now:
- ✅ Save persistent history (2000 messages, survives restarts)
- ✅ Track contacts in universal DB
- ✅ Auto-extract preferences every 10 messages
- ✅ Inject preferences into system prompts
- ✅ Save all messages to contacts DB

**Legacy script:** archived under `docs/archive/legacy-tests/root/test-cross-platform.mjs`

### Quick Commands

```bash
# View all contacts (both platforms)
sqlite3 ~/.crewswarm/contacts.db "SELECT display_name, platform, message_count FROM contacts;"

# View preferences
sqlite3 ~/.crewswarm/contacts.db "SELECT display_name, preferences FROM contacts WHERE preferences != '{}';"

# View collections
sqlite3 ~/.crewswarm/collections.db "SELECT title, tags FROM collection_items;"
```

**Full docs:**
- `WHATSAPP-TELEGRAM-INTEGRATION.md` - How both platforms work together
- `GENERIC-COLLECTIONS.md` - Collections system explained
- `FINAL-TEST-RESULTS.md` - Test results and verification

---

## Key files to know

**Every time you edit `scripts/dashboard.mjs`:** run `node scripts/check-dashboard.mjs` before you're done. Dashboard edits often break the inline script (quotes, template literals); the check shows the exact line that breaks. Run it after every dashboard change — not just before commit. Use `--source-only` if the full check times out.

| File | What it does |
|---|---|
| `crew-lead.mjs` | Conversational commander, HTTP server on :5010 |
| `gateway-bridge.mjs` | Per-agent daemon — calls LLM, executes tools |
| `scripts/dashboard.mjs` | API server on :4319; serves Vite frontend from `apps/dashboard/dist`. **UI code is NOT here.** |
| `apps/dashboard/index.html` | **Dashboard HTML structure** — tabs, cards, layout. Edit this for UI changes. |
| `apps/dashboard/src/app.js` | **Dashboard JavaScript** — all functions, event handlers, API calls. Edit this for UI changes. |
| `apps/dashboard/src/styles.css` | **Dashboard CSS** — variables, components, layout. |
| `apps/dashboard/dist/` | Built output from `cd apps/dashboard && npm run build`. This is what the server serves. |
| `apps/dashboard/` | Vite dashboard UI (`npm run build` outputs to `apps/dashboard/dist`) |
| `scripts/mcp-server.mjs` | MCP + OpenAI-compatible API on :5020 — exposes agents/skills to Cursor, Claude Code, Open WebUI, etc. **(optional — core stack works without it)** |
| `scripts/check-dashboard.mjs` | Validates dashboard HTML/inline script — **run after editing dashboard.mjs** to avoid breaking the UI |
| `scripts/health-check.mjs` | Fast diagnostic — checks all services, agents, and MCP in one shot |
| `telegram-bridge.mjs` | Telegram integration |
| `whatsapp-bridge.mjs` | WhatsApp integration (personal bot via Baileys — scan QR once) |
| `scripts/crew-scribe.mjs` | Memory maintenance (summaries, lessons) |
| `~/.crewswarm/crewswarm.json` | Agent model assignments + provider API keys |
| `~/.crewswarm/crewswarm.json` | RT auth token |
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

## Skill plugins

Skills live in `~/.crewswarm/skills/` and come in two distinct types. Both are called with `@@SKILL skillname {params}` but behave differently:

### API skills (`.json` files) — call external endpoints

```json
{
  "description": "Post a tweet",
  "url": "https://api.twitter.com/2/tweets",
  "method": "POST",
  "auth": { "type": "bearer", "keyFrom": "providers.twitter" },
  "defaultParams": {},
  "paramNotes": "text: string (max 280 chars)"
}
```

**Optional fields:**
- `listUrl` — fallback URL when main URL's path param is empty (e.g. list all items)
- `listUrlIdField` — field to extract from `listUrl` response for health snapshot display
- `aliases` — `["benchmark", "benchmarks"]` — friendly names that resolve to this skill
- `paramAliases` — `{"benchmark_id": {"human-eval": "humaneval"}}` — normalize wrong values

Bundled: `elevenlabs.tts`, `fly.deploy`, `polymarket.trade`, `twitter.post`, `zeroeval.benchmark`, `webhook.post`, `read-log`, `swebench.task`.

### Knowledge skills (`SKILL.md` folders) — inject playbooks into agent context

```
~/.crewswarm/skills/
└── code-review/
    └── SKILL.md
```

`SKILL.md` format (YAML frontmatter + Markdown body):
```markdown
---
name: code-review
description: Structured review framework — correctness, security, performance, readability.
aliases: [review, pr-review]
---

# Code Review Skill

## Checklist
...frameworks and checklists here...
```

When an agent calls `@@SKILL code-review {}`, the full markdown body is injected into its context. No HTTP call is made — this is context injection.

**36 knowledge skills installed** across: engineering (code-review, api-design, component-design, threat-model, adr-generator, git-pr-workflow, test-strategy, root-cause-analysis, ml-evaluation, synthesis-advisor, design-system-advisor), PM (roadmap-planning, problem-statement, prioritization-advisor, epic-breakdown-advisor, product-strategy-session, user-story, problem-framing-canvas, opportunity-solution-tree, epic-hypothesis, discovery-process), and GTM (ai-seo, content-to-pipeline, positioning-icp, gtm-metrics, ai-pricing, solo-founder-gtm, lead-enrichment, ai-cold-outreach, social-selling, multi-platform-launch, ai-ugc-ads, paid-creative-ai, expansion-retention, partner-affiliate, gtm-engineering).

### Dashboard Skills tab

Shows two sections: **Knowledge** (SKILL.md skills) and **API Integrations** (JSON endpoint skills). Import new skills via **Skills tab → Import URL** — paste any raw GitHub URL to a `.json` or `SKILL.md` file.

### Per-agent skill assignments

Each agent has a primary skill referenced in its system prompt:

| Agent | Skill |
|---|---|
| crew-coder | `code-review` |
| crew-coder-front | `component-design` |
| crew-coder-back | `api-design` |
| crew-frontend | `design-system-advisor` |
| crew-github | `git-pr-workflow` |
| crew-qa | `test-strategy` |
| crew-fixer | `root-cause-analysis` |
| crew-security | `threat-model` |
| crew-main | `synthesis-advisor` |
| crew-architect | `adr-generator` |
| crew-seo | `ai-seo` |
| crew-copywriter | `content-to-pipeline` |
| crew-researcher | `positioning-icp` |
| crew-ml | `ml-evaluation` |
| crew-pm | `roadmap-planning` + `problem-statement` + `prioritization-advisor` + `epic-breakdown-advisor` |

---

## Roadmap, PDD, and paths

Every new project gets **three** planning documents written to `<outputDir>/`:

| File | What it is | Who writes it |
|---|---|---|
| `PDD.md` | Product Design Doc — persona, problem, success metrics, constraints, non-goals, decisions | crew-pm (wave 3) or template at confirm time |
| `TECH-SPEC.md` | Technical Specification — architecture diagram, tech stack, data models, API contracts, file structure, deployment, security | crew-pm + crew-architect (wave 3) or template at confirm time |
| `ROADMAP.md` | Phased task list — agents, file paths, acceptance criteria | crew-pm (wave 3) or AI generation |

- **One PDD + one TECH-SPEC + one ROADMAP per project.** They live at `<outputDir>/PDD.md`, `<outputDir>/TECH-SPEC.md`, `<outputDir>/ROADMAP.md`.
- **Repo root** `ROADMAP.md` = ops/core (crewswarm itself). `website/ROADMAP.md` = website project only.
- **PM:** When a task says "the roadmap", use the project's outputDir when given; otherwise repo root = ops/core.
- **PRD interview:** When crew-lead receives a vague "build me X" request, it asks 5 questions (persona, problem, success metric, constraints, non-goals) before firing the planning pipeline. The answers seed wave 1 and land in `PDD.md`.
- **Planning pipeline (3 waves):**
  - **Wave 1:** crew-pm scopes + crew-copywriter researches
  - **Wave 2:** crew-architect (system architecture) + crew-coder-front + crew-frontend + crew-qa + crew-security (all provide consultation)
  - **Wave 3:** crew-pm compiles all input → writes PDD.md + TECH-SPEC.md + ROADMAP.md

### Domain-Aware Planning (for large repos)

For codebases **100K+ lines** with distinct subsystems (CLI, frontend, core runtime, integrations), crewswarm routes roadmap items to **domain-specific PM agents** who specialize in that area of the codebase.

**How it works:**

1. PM loop reads a roadmap item (e.g. "Add --verbose flag to crew exec")
2. Domain detector analyzes keywords and matches to a domain:
   - **crew-cli**: CLI tools, TypeScript, command-line interfaces
   - **frontend**: Dashboard, HTML/CSS/JS, Vite
   - **core**: Gateway, crew-lead, orchestration, runtime
   - **integrations**: Telegram, WhatsApp, MCP, skills
   - **docs**: Documentation, markdown
3. If confidence > 50%, the item is sent to the domain-specific PM agent
4. Domain PM expands the item with subsystem-specific context and file paths
5. Worker agents receive precise, contextual tasks

**Example flow:**

```
Roadmap item: "Add --verbose flag to crew exec"
↓
Domain detector: crew-cli (80% confidence)
↓
Routed to: crew-pm-cli (CLI specialist)
↓
Task expanded: "crew-cli/src/cli/index.ts — Add --verbose flag; crew-cli/src/executor/local.ts — Pass verbose to executor; crew-cli/test/verbose.test.ts — Test verbose output"
↓
Dispatched to: crew-coder-back (TypeScript specialist)
```

**Benefits:**

- **Fewer hallucinated paths** — domain PMs know the subsystem structure
- **Better context** — domain-specific patterns and conventions
- **Faster iteration** — workers get precise, scoped tasks
- **Scale to 500K+ lines** — each domain PM owns their subsystem

**Configuration:**

Domain detection is automatic. Domain definitions live in `lib/domain-planning/detector.mjs`. Domain PM prompts live in `lib/domain-planning/prompts/`. To customize:

```javascript
// lib/domain-planning/detector.mjs
export const DOMAINS = {
  'my-subsystem': {
    pmAgent: 'crew-pm-custom',
    keywords: ['custom', 'subsystem', 'module'],
    description: 'Custom subsystem',
    subdirs: ['my-subsystem/']
  }
};
```

Then create `lib/domain-planning/prompts/crew-pm-custom.md` and register `crew-pm-custom` in `crewswarm.json`.

**Activation:**

Domain-aware planning is **always on** for large repos. No env var needed. If no domain matches (confidence < 50%), the item falls back to the default `crew-pm`.
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
| `crew-pm-cli` | 🎯 **Domain PM for CLI** — specializes in crew-cli subsystem planning |
| `crew-pm-frontend` | 🎯 **Domain PM for Frontend** — specializes in dashboard UI planning |
| `crew-pm-core` | 🎯 **Domain PM for Core** — specializes in orchestration and runtime planning |
| `crew-judge` | 🎯 **Cycle decision maker** — evaluates PM loop progress and decides: CONTINUE, SHIP, or RESET |
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
- `crew-pm-cli`, `crew-pm-frontend`, `crew-pm-core`: domain-specific planning specialists — route roadmap items to the PM with expertise in that subsystem.
- `crew-main`: general coordinator and final synthesis/verification.

### OpenCode orchestrator roles

- OpenCode `build`: delegation-only build orchestrator.
- OpenCode `orchestrator`: tool-based orchestrator (`code_execute`, `code_validate`, `code_status`).
- crewswarm runtime uses `orchestrator` / `crew-pm` / `crew-main` as the main coordination chain.

### PM-loop synthesis → OpenCode

- After the swarm completes roadmap tasks, PM-loop calls **crew-main** for final synthesis (audit + assembly).
- The crew-main daemon is in `OPENCODE_AGENTS` in `gateway-bridge.mjs`, so it routes those tasks to **OpenCode** when `CREWSWARM_OPENCODE_ENABLED` is on.
- PM-loop sets `CREWSWARM_OPENCODE_PROJECT` to the PM output dir when invoking crew-main; the bridge passes it as `payload.projectDir` so OpenCode runs in the build output directory.

### Ouroboros-style LLM ↔ Engine loop

- When an agent has **Engine loop** enabled (`opencodeLoop: true` in `crewswarm.json` or `CREWSWARM_ENGINE_LOOP=1`), the gateway runs a multi-step loop instead of a single engine call: the **role’s LLM** is asked for “STEP: &lt;instruction&gt; or DONE”; each STEP is sent to the agent's active engine (OpenCode, Cursor CLI, Claude Code, or Codex) as a mini task; results are fed back until the LLM says DONE or `CREWSWARM_ENGINE_LOOP_MAX_ROUNDS` (default 10) is reached. Same idea as [Ouroboros](https://github.com/joi-lab/ouroboros) tool loop, adapted for multi-agent: each agent can run this loop when handling a task.

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

crew-lead exposes a REST API for external tools. Auth: Bearer token from `~/.crewswarm/crewswarm.json → rt.authToken`.

```bash
TOKEN=$(cat ~/.crewswarm/crewswarm.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")

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
npm run restart-all             # restart everything
node scripts/start-crew.mjs     # restart just the agent bridges
node crew-lead.mjs              # restart just crew-lead

# ⚠️ DASHBOARD RESTART — Important for AI assistants
npm run restart-dashboard       # restart dashboard (use this, NOT the API)
# Alternative: bash scripts/restart-dashboard.sh
# NOTE: The dashboard CANNOT restart itself via its REST API (race condition).
#       Always use the dedicated restart script above.

# Check logs
tail -f /tmp/crew-lead.log
tail -f /tmp/opencrew-rt-daemon.log
tail -f /tmp/dashboard.log
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
0 9 * * * cd /path/to/crewswarm && node scripts/run-scheduled-pipeline.mjs social >> ~/.crewswarm/logs/cron.log 2>&1
```

crew-lead must be running (port 5010). Auth: `~/.crewswarm/crewswarm.json` → `rt.authToken`.

---

## Customizing the crew

### Change an agent's model

Edit `~/.crewswarm/crewswarm.json`:

```json
{ "id": "crew-coder", "model": "anthropic/claude-sonnet-4-5" }
```

Format is always `provider/model-id`. Provider must have an API key in the `providers` block of the same file.

To enable the **Ouroboros-style LLM ↔ OpenCode loop** for an agent (LLM decomposes task into steps, each step run by OpenCode, until DONE), set `opencodeLoop: true` for that agent in `crewswarm.json`, or set env `CREWSWARM_ENGINE_LOOP=1` for all. Optional: `CREWSWARM_ENGINE_LOOP_MAX_ROUNDS` (default 10).

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

## Telegram bridge — how to set up

**Official Telegram Bot API** — create a bot via BotFather, no phone number needed.

### Initial Setup (one-time)

**1. Create a bot:**
- Open Telegram and message [@BotFather](https://t.me/BotFather)
- Send `/newbot`
- Follow prompts (name, username)
- **Copy the bot token** (looks like `8078407232:AAHVNzRnoUilRbIBjwh...`)

**2. Add token to crewswarm:**

**Dashboard method** (recommended):
- Open `http://127.0.0.1:4319` → **Communications** tab
- Paste token in **Telegram Bot Token** field
- Click **💾 Save**

**Or manual method:**
```bash
# Edit the config
code ~/.crewswarm/telegram-bridge.json

# Add:
{
  "token": "8078407232:AAHVNzRnoUilRbIBjwh...",
  "allowedChatIds": []
}
```

**3. Start the bridge:**
```bash
npm run telegram
# or: node telegram-bridge.mjs
```

**4. Test it:**
- Find your bot on Telegram (search for the @username you created)
- Send `/start`
- Bot should reply!

### Topic Routing Setup (for Supergroups)

**Enable different agents per topic in a single group.**

**1. Create a Supergroup:**
- Telegram → New Group → Add some members → Convert to Supergroup
- Settings → Enable Topics

**2. Get the Group ID:**
- Add your bot to the group (invite like any user)
- In the group, send: `/chatid`
- Bot replies: `Chat ID: -1003624332545` ← copy this

**3. Configure routing in the dashboard:**

`http://127.0.0.1:4319` → **Communications** → **Telegram Topic Routing**

- Click **➕ Add New Group**
- Paste Group ID: `-1003624332545`
- For each topic, click **➕** and add:
  - **Topic ID**: `20`, `94`, etc. (get from `/chatid` in that topic)
  - **Agent**: `crew-pm`, `crew-loco`, etc.
  - **main**: Routes general group chat (no topic)

**Example config:**
```json
{
  "topicRouting": {
    "-1003624332545": {
      "20": "crew-loco",
      "94": "crew-pm",
      "main": "crew-lead"
    }
  }
}
```

**4. Add group to allowed chats:**

Same tab → **Allowed Chat IDs** → Add `-1003624332545` → Save

**No restart needed!** Config changes apply immediately.

### How Topic Agents Work

**Fast chat + self-dispatch capability:**

- **Direct LLM calls** for conversational speed
- **Self-dispatch** when they need tool execution
- **Role-based permissions** to prevent cross-contamination

**Example:**
```
You (Topic 94 → crew-pm): Create a roadmap for a todo app

crew-pm: Sure! I'll create that for you.
⚡ crew-pm dispatching to crew-coder...
[crew-coder creates file via gateway]
crew-coder: ✅ Created /tmp/todo-app/ROADMAP.md
```

**Each topic = isolated conversation history** (no personality bleeding between topics).

### Topic Agent Permissions (NEW: March 2026)

Each topic agent runs with **role-based tool permissions** to control what they can access:

| Permission | crew-pm | crew-coder | crew-loco |
|---|---|---|---|
| Projects API (system projects) | ✅ Yes | ❌ No | ❌ No |
| `@@DISPATCH` (delegate to agents) | ✅ Yes | ✅ Yes | ❌ No |
| `@@CLI` (file operations) | ✅ Yes | ✅ Yes | ❌ No |
| `@@WEB_SEARCH` / `@@WEB_FETCH` | ✅ Yes | ✅ Yes | ✅ Yes |

**crew-pm agents** (crew-pm, crew-pm-cli, crew-pm-frontend, crew-pm-core):
- Get full system projects context (names, paths, roadmaps, progress)
- Can dispatch to specialists
- Can use CLI tools
- Use case: Project planning, roadmap coordination

**Specialist agents** (crew-coder, crew-qa, crew-security, etc.):
- No projects context (focused on assigned tasks)
- Can dispatch to other specialists
- Can use CLI tools
- Use case: Implementation work, can delegate subtasks

**crew-loco (chat-only mode)** 🔒:
- NO projects context
- NO dispatch capability
- NO CLI tools
- ONLY web search
- Use case: GrabLoco conversational bot — isolated from crewswarm infrastructure

**Permission enforcement:**
- System prompt injection (tools shown based on permissions)
- Runtime blocking (unauthorized tool calls are rejected with error message)

**Example isolation:**
```
You (Topic 20 → crew-loco): Can you dispatch a task to crew-coder?
crew-loco: ⚠️ crew-loco does not have dispatch permissions (chat-only mode)
```

See `TELEGRAM-TOPIC-AGENT-PERMISSIONS.md` for full permission matrix and testing instructions.
See `TELEGRAM-SELF-DISPATCH.md` for tool execution details.

### Commands

```
/chatid    — Get chat/topic ID for setup
/start     — Wake up the bot
/help      — Show available commands
```

### Privacy Settings

**By default, bots in groups can only see messages that:**
- Start with `/` (commands)
- @mention the bot
- Are replies to the bot

**To let the bot see all messages** (needed for topic routing):
- Message @BotFather
- Send `/setprivacy`
- Choose your bot
- Select **Disable** (bot sees all group messages)

**Security:** Use `allowedChatIds` to restrict which groups/users can interact.

### Restrict Access

**Allowlist specific users/groups:**

Dashboard → Communications → **Allowed Chat IDs**

Add user IDs or group IDs (one per line):
```
1693963111
-1003624332545
```

**To get a user's ID:** Have them message @userinfobot on Telegram.

**Logs:** `~/.crewswarm/logs/telegram-bridge.jsonl` and `telegram-messages.jsonl`

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

crewswarm runs a built-in **MCP server on port 5020**. Connect it to Cursor, Claude Code, OpenCode, or any MCP-compatible client and your full 20-agent crew becomes available as callable tools — from any project, not just the crewswarm repo.

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

| Cursor built-in | crewswarm via MCP |
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

Find your auth token: `cat ~/.crewswarm/crewswarm.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])"`

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

## MCP Integration — use crewswarm agents in any project

crewswarm runs an MCP server on port **5020**. Wire it into Cursor, Claude Code, OpenCode, crew-cli, or Gemini CLI and all 20 agents become available as callable tools in any project — no AGENTS.md copy needed.

**Auto-setup (recommended):** run `bash install.sh` and answer `y` to the MCP prompt. It configures Cursor, Claude Code, and OpenCode automatically.

**Manual setup:** get your auth token, then add the crewswarm entry to each tool's MCP config:

```bash
TOKEN=$(node -e "const c=require('fs').readFileSync(require('os').homedir()+'/.crewswarm/crewswarm.json','utf8');console.log(JSON.parse(c).rt?.authToken)")
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

**Gemini CLI** — uses command-line registration:
```bash
gemini mcp add crewswarm "http://127.0.0.1:5020/mcp" \
  --transport http \
  --header "Authorization: Bearer $TOKEN" \
  --description "crewswarm - 20 agents + 46 skills" \
  --trust
```
Config is stored in `.gemini/settings.json` (project-level).

**crew-cli** — uses its own MCP config via CLI:
```bash
# Store your token permanently
echo 'export CREWSWARM_TOKEN="<TOKEN>"' >> ~/.zshenv

# Register the MCP server
codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN
```
The token is read from `$CREWSWARM_TOKEN` at runtime — Codex handles auth automatically.

Once configured, agents appear as MCP tools in all four editors. The MCP server must be running (`npm run restart-all` starts it on :5020).

---

## Environment variables reference

All variables can be set in `~/.crewswarm/crewswarm.json` under the `env` key, or exported before starting services. Visible in the dashboard **Settings → Environment Variables** tab.

### Engine timeouts (activity-based watchdogs)

| Variable | Default | What it controls |
|---|---|---|
| `CREWSWARM_ENGINE_IDLE_TIMEOUT_MS` | `300000` | Kill engine process after this many ms of silence (no stdout/stderr). Resets on any output. |
| `CREWSWARM_ENGINE_MAX_TOTAL_MS` | `1800000` | Absolute ceiling per engine task regardless of activity (30 min). |
| `PM_AGENT_IDLE_TIMEOUT_MS` | `900000` | Kill PM loop's `--send` subprocess after this many ms of silence. |
| `PHASED_TASK_TIMEOUT_MS` | `600000` | Per-agent timeout inside the PM loop's phased dispatch. |
| `CREWSWARM_DISPATCH_TIMEOUT_MS` | `300000` | ms before an unclaimed dispatched task times out. |
| `CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS` | `900000` | Timeout for tasks already claimed by an agent bridge. |

### PM loop behaviour

| Variable | Default | What it controls |
|---|---|---|
| `PM_MAX_ITEMS` | `200` | Max roadmap items per PM loop run. |
| `PM_MAX_CONCURRENT` | `20` | Max parallel tasks dispatched simultaneously. |
| `PM_CODER_AGENT` | `crew-coder` | Override default coding agent for PM loop. |
| `PM_USE_QA` | `off` | Include crew-qa quality gate in PM pipeline. |
| `PM_USE_SECURITY` | `off` | Include crew-security in PM pipeline. |
| `PM_USE_SPECIALISTS` | `off` | Keyword-based routing: frontend→crew-coder-front, backend→crew-coder-back, git→crew-github. |
| `PM_SELF_EXTEND` | `off` | Auto-generate new roadmap items when roadmap empties. |
| `PM_EXTEND_EVERY` | `5` | Self-extend every N items completed. |
| `PM_USE_JUDGE` | `on` | Call crew-judge after each cycle to decide CONTINUE/SHIP/RESET. |
| `PM_JUDGE_EVERY` | `5` | Run judge decision after every N items completed. |
| `CREW_JUDGE_MODEL` | `groq/llama-3.3-70b-versatile` | Model for judge decisions (should be fast + cheap). |

### Engine routing

| Variable | Default | What it controls |
|---|---|---|
| `CREWSWARM_OPENCODE_ENABLED` | `off` | Route coding agents through OpenCode globally. |
| `CREWSWARM_OPENCODE_MODEL` | per-agent | Model passed to OpenCode. |
| `CREWSWARM_OPENCODE_TIMEOUT_MS` | `300000` | ms before OpenCode task is killed. |
| `CREWSWARM_ENGINE_LOOP` | `off` | Enable Ouroboros LLM↔engine loop for all agents. |
| `CREWSWARM_ENGINE_LOOP_MAX_ROUNDS` | `10` | Max STEP iterations per Ouroboros loop run. |
| `CREWSWARM_GEMINI_CLI_ENABLED` | `off` | Route agents through Gemini CLI. |
| `CREWSWARM_GEMINI_CLI_MODEL` | — | Which Gemini model (e.g. `gemini-2.0-flash`). |
| `CREW_CLAUDE_SKIP_PERMISSIONS` | `off` | ⚠️ **SECURITY RISK:** Bypass Claude CLI permission checks. Allows agents to execute arbitrary host commands via prompt injection. Only enable in sandboxed/trusted environments. |

### Background consciousness

| Variable | Default | What it controls |
|---|---|---|
| `CREWSWARM_BG_CONSCIOUSNESS` | `off` | Enable idle reflection loop for crew-main. |
| `CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS` | `900000` | Idle reflection interval (15 min). |
| `CREWSWARM_BG_CONSCIOUSNESS_MODEL` | `groq/llama-3.1-8b-instant` | Model for background cycle. |

### Ports

| Variable | Default | What it controls |
|---|---|---|
| `CREW_LEAD_PORT` | `5010` | crew-lead HTTP server port. |
| `SWARM_DASH_PORT` | `4319` | Dashboard port. |
| `WA_HTTP_PORT` | `5015` | WhatsApp bridge HTTP port. |

---

## Troubleshooting

**Agents not responding** — run `npm run restart-all`, check logs in `/tmp/`. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for detailed fixes.

**No API key error** — open dashboard → Providers tab, add a Groq key (free).

**crew-lead not reachable** — `curl http://127.0.0.1:5010/health` — if 404, restart with `node crew-lead.mjs`.

**Dashboard won't start or restart** — The dashboard cannot restart itself via its REST API (prevents race condition). Use: `npm run restart-dashboard` or `bash scripts/restart-dashboard.sh`. Never call the `/api/services/restart` endpoint with `"id":"dashboard"` — it will always fail with an error message.

**File not written by agent** — agent's tool permissions come from `~/.crewswarm/crewswarm.json → agents[].tools.crewswarmAllow` or role defaults in `gateway-bridge.mjs → AGENT_TOOL_ROLE_DEFAULTS`.

**Duplicate Telegram/WhatsApp replies** — multiple bridge instances running. `pkill -f telegram-bridge.mjs && node telegram-bridge.mjs &`. Bridges have singleton guards (PID files) — remove stale `.pid` file in `~/.crewswarm/logs/` if needed.

**Skills tab shows only 7 skills** — restart crew-lead. The API now returns all 44 skills (JSON + SKILL.md) with `type: "api" | "knowledge"` field.
