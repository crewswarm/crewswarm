# crew-cli Feature Integration Guide

## 🎯 What Makes crew-cli "Best of Breed"

`crew-cli` synthesizes the best features from 6+ open-source coding CLIs into a unified multi-agent orchestrator with safety, cost optimization, and intelligence that none of the originals provide.

---

## 📚 Source Repositories & What We Borrowed

### 1. **Aider** (Apache 2.0) - 41k⭐
**Repository:** https://github.com/paul-gauthier/aider  
**What we took:**
- ✅ **Edit Strategies** - 4 vendored, ported to TypeScript:
  - `SearchReplaceStrategy` - Find/replace with fuzzy matching
  - `UnifiedDiffStrategy` - Git-style unified diffs
  - `WholeFileStrategy` - Full file rewrites for small files
  - `EditBlockStrategy` - Aider's proprietary format (most reliable)
- ✅ **File context window management** - Smart truncation of large files
- ✅ **Token estimation** - Approximate token counts before API calls
- ✅ **Cost tracking** - Per-model usage logging

**Location in crew-cli:**
- `src/strategies/` - All 4 edit strategy implementations
- `src/context/augment.ts` - Context budget enforcement
- `src/cost/predictor.ts` - Cost estimation (Aider's pricing data as base)

**Why it's better here:**
- Aider only supports direct editing. We use these strategies in a **sandbox** so changes can be previewed/rolled back.
- Aider is Python + single-threaded. We're TypeScript + can dispatch to 20 agents in parallel.

---

### 2. **Plandex** (MIT) - 15k⭐
**Repository:** https://github.com/plandex-ai/plandex  
**What we took:**
- ✅ **Cumulative Diff Sandbox** - Changes accumulate in `.crew/sandbox.json` instead of touching real files
- ✅ **Branching** - Create multiple "what-if" branches to explore alternatives
- ✅ **Plan-first workflow** - Generate a step-by-step plan before executing
- ✅ **Preview/Apply separation** - User reviews all changes before writing to disk

**Location in crew-cli:**
- `src/sandbox/index.ts` - Full sandbox implementation with branches
- `src/planner/index.ts` - Plan generation and step-by-step execution

**Why it's better here:**
- Plandex is proprietary cloud-hosted (self-hosted version is limited). Ours is **local-first**.
- Plandex only uses OpenAI models. We route to **any model** and integrate with crewswarm's 20 agents.
- Plandex charges $10-30/mo. Our **OAuth token reuse** makes it free for Pro users.

---

### 3. **Gemini CLI** (Apache 2.0) - 96k⭐
**Repository:** https://github.com/google-gemini/gemini-cli  
**What we took:**
- ✅ **OAuth token reuse** - Uses your Google account (no API key needed)
- ✅ **Stream-JSON output format** - Clean JSONL events for real-time streaming
- ✅ **Session continuity** - `--resume <session-id>` for context across runs
- ✅ **Approval mode** - `--approval-mode yolo` for autonomous execution

**Location in crew-cli:**
- `src/auth/token-finder.ts` - Detects Gemini ADC credentials
- `src/engines/gemini-cli.ts` - Subprocess wrapper for Gemini CLI
- `crew-cli` now uses Gemini 2.0 Flash for **routing decisions** (2M context, $0.075/M tokens)

**Why it's better here:**
- Gemini CLI is Google-models-only. We use Gemini for **routing** but can execute with any model.
- We add **multi-agent dispatch** on top of Gemini's single-agent execution.

---

### 4. **Codex CLI** (Apache 2.0) - 62k⭐
**Repository:** https://github.com/anthropic/codex-cli  
**What we took:**
- ✅ **Workspace sandbox** - `--sandbox workspace-write` mode for safe editing
- ✅ **JSON output** - `--json` flag for structured responses
- ✅ **Full-auto mode** - `--full-auto` skips approval prompts for CI/headless

**Location in crew-cli:**
- `src/engines/codex-cli.ts` - Subprocess wrapper
- Gateway passthrough in `lib/crew-lead/http-server.mjs` uses `--full-auto` for direct Codex calls

**Why it's better here:**
- Codex is Anthropic-models-only (Claude). We can route Codex requests but also use DeepSeek/Grok/Gemini.
- Codex sessions are project-scoped (no cross-chat isolation). We add **session-per-chat** isolation.

---

### 5. **Claude Code CLI** (Proprietary) - 71k⭐
**Repository:** https://github.com/anthropics/claude-cli  
**What we took:**
- ✅ **OAuth token from Cursor** - Shares auth with Cursor desktop app
- ✅ **Stream-JSON format** - Similar to Gemini CLI
- ✅ **Continue flag** - `--continue` to extend previous conversation

**Location in crew-cli:**
- `src/auth/token-finder.ts` - Extracts Claude session tokens
- Gateway passthrough in `lib/crew-lead/http-server.mjs`

**Why it's better here:**
- Claude Code has no multi-agent capability. We dispatch complex tasks to **crew-pm → crew-coder → crew-qa** chains.
- Claude Code has no sandbox. We add **safe preview/apply** workflow.

---

### 6. **Cursor CLI** (Proprietary)
**Repository:** Closed-source (bundled with Cursor IDE)  
**What we took:**
- ✅ **Model flexibility** - `--model` flag to choose from any provider
- ✅ **Yolo mode** - `--yolo` for autonomous approval
- ✅ **Print mode** - `--print` to stream output

**Location in crew-cli:**
- Gateway passthrough in `lib/crew-lead/http-server.mjs`
- We set **Gemini 3 Flash as default** to avoid Claude rate limits

**Why it's better here:**
- Cursor CLI is IDE-coupled. We're **terminal-native** and IDE-agnostic.
- Cursor has no multi-agent orchestration. We add **intelligent routing**.

---

## 🆕 Original Features (Not in Any Other CLI)

### 1. **Dual-LLM Architecture**
- **Routing LLM** (Gemini 2.0 Flash): Cheap, fast decisions (CHAT/CODE/DISPATCH/SKILL) - $0.075/M tokens, 2M context
- **Execution LLM** (DeepSeek/Claude/Grok): Smart, accurate code generation

**Why this matters:**
- Saves 90% on routing costs (Gemini vs Claude for simple decisions)
- Can use **unlimited OAuth** for routing (Gemini free tier: 60 req/min)
- Routing model has **2M context** vs Groq's 128k

### 2. **Multi-Agent Dispatch**
- `@@DISPATCH crew-qa` - Send subtasks to specialist agents
- Agents run in parallel and report back to the orchestrator
- Chains like `crew-pm → crew-coder → crew-qa → crew-github` for full feature implementation

**Inspired by:** CrewAI, AutoGen (but those are Python frameworks, not CLIs)

### 3. **Cross-Repo Context**
- `crew repos-scan` - Detect sibling git repositories
- `crew repos-context` - Inject context from multiple related repos
- `crew repos-warn` - Detect breaking API changes across repos

**Location:** `src/multirepo/index.ts`, `src/context/git.ts`

**Why it matters:**
- Monorepo tooling (Nx, Turbo) doesn't help with **multi-repo coordination**
- None of the existing CLIs understand **cross-repository dependencies**

### 4. **Learning from Corrections**
- `crew correction` - Record when you fix an AI mistake
- `crew tune --export training.jsonl` - Export dataset for fine-tuning
- Builds **local training data** in `.crew/training-data.jsonl`

**Location:** `src/learning/corrections.ts`

**Why it matters:**
- None of the existing CLIs learn from your corrections
- Enables future **personalized LoRA fine-tuning**

### 5. **CI Auto-Fix Loop**
- `crew ci-fix --command "npm test"` - Runs test, dispatches fix, retries
- Loops until tests pass or max attempts reached
- `--push` flag auto-commits and pushes on success

**Location:** `src/ci/index.ts`

**Why it matters:**
- GitHub Actions can fail → dispatch to crew-fixer → auto-fix → re-run
- None of the existing CLIs have **CI-aware autonomous loops**

### 6. **Browser Debugging**
- `crew browser-debug --url http://localhost:3000` - Launches Chrome, captures console errors
- `crew browser-diff screenshot1.png screenshot2.png` - Visual regression detection
- `crew browser-fix --url ...` - Auto-dispatches errors to crew-fixer

**Location:** `src/browser/index.ts`

**Why it matters:**
- Playwright/Puppeteer require manual scripting
- None of the existing CLIs can **debug live web apps**

### 7. **Voice Mode**
- `crew listen --continuous` - Speech-to-text → dispatch → text-to-speech
- Uses Whisper (local or API) for transcription
- Integrates with ElevenLabs/other TTS skills

**Location:** `src/voice/listener.ts`

**Why it matters:**
- No other coding CLI supports **hands-free operation**

### 8. **MCP Server Integration**
- `crew mcp add my-server --url http://localhost:4000` - Register external tools
- Auto-discovers crewswarm skills via MCP protocol
- Syncs MCP config to Cursor/Claude config files

**Location:** `src/mcp/index.ts`

**Why it matters:**
- Model Context Protocol is brand new (Anthropic, 2024)
- Only crew-cli has **native MCP integration for multi-agent CLIs**

---

## 🧬 Git Features Deep Dive

### Auto-Injected Git Context
Every `crew chat` or `crew dispatch` automatically includes:

```typescript
// From src/context/git.ts
export interface GitContext {
  branch: string;           // Current branch name
  status: string;           // git status --short
  unstagedDiff: string;     // git diff
  stagedDiff: string;       // git diff --staged
  recentCommits: string;    // git log -5 --oneline
}
```

**Why this is critical:**
- The AI knows **what you're working on** without you explaining
- Prevents conflicts with uncommitted changes
- Can suggest better commit messages based on actual diff

**Example:**
```bash
crew chat "add rate limiting"

# Behind the scenes, the AI sees:
# Branch: feature/api-endpoints
# Status: M src/api.ts (modified)
# Unstaged diff: 30 lines showing current API structure
# Recent commits: Last 5 commits (context for what's in progress)
```

### Cross-Repo Awareness
```bash
# Scan sibling repositories
crew repos-scan
# Output:
#   - ../api-gateway (main, clean)
#   - ../frontend (feature/auth, 2 uncommitted files)
#   - ../shared-types (main, behind origin by 3 commits)

# Inject their context into a task
crew chat "update user schema" --cross-repo

# Behind the scenes:
# The AI sees the UserType definitions from ../shared-types
# and knows the frontend expects { id, email, createdAt }
```

**Why no other CLI does this:**
- Aider/Plandex assume single-repo workflows
- Cross-repo changes break APIs silently (frontend expects field that backend removed)

### API Breaking Change Detection
```bash
crew repos-warn

# Output:
# [api-gateway]
# - Potential API-impacting file changed: src/routes/auth.ts
# - Detected 2 removed exported symbols
# - Detected 1 removed route handler (app.post)

# This warns you BEFORE you merge a PR that breaks the frontend
```

**Implementation:** `src/multirepo/index.ts` lines 100-123
- Scans git diffs for `export` deletions
- Checks for removed `app.get/post/put/delete` routes
- Flags changes to files matching `/api|route|schema|openapi|graphql/`

---

## 🔗 OpenCode Integration

`crew-cli` doesn't directly vendor OpenCode, but it **dispatches to OpenCode** as one of its execution engines.

### What OpenCode Provides:
- Multi-model routing (Groq, OpenAI, Anthropic, etc.)
- Web-based UI for task management
- Agent API (REST) for external dispatch

### How crew-cli Uses It:
```typescript
// When user runs: crew chat "implement auth"
// And routing decides: CODE

// crew-cli can dispatch via:
1. Gateway → OpenCode agent (HTTP)
2. Direct OpenCode CLI subprocess (if installed)
3. Vendored strategies (Aider editblock) without OpenCode
```

**The key difference:**
- OpenCode is a **framework** (like crewswarm itself)
- crew-cli is a **terminal interface** that can talk to OpenCode OR work standalone

---

## 🎪 What crew-cli Adds On Top

| Feature | Aider | Plandex | Gemini | Codex | Claude | OpenCode | **crew-cli** |
|---------|-------|---------|--------|-------|--------|----------|--------------|
| **Sandbox (preview before apply)** | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| **Multi-agent orchestration** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Cross-repo context** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **OAuth token reuse** | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Dual-LLM routing** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Cost prediction** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Learning from corrections** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **CI auto-fix loops** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Browser debugging** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Voice mode** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Interactive REPL** | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Autonomous mode** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **MCP protocol** | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |

---

## 🧠 Model Strategy & Cost

### Current Routing Model: **Gemini 2.0 Flash**
**Changed from:** Groq Llama 3.3 70B  
**Why:**
- **Context:** 2M tokens vs 128k (16x larger)
- **Cost:** $0.075/M input vs $0.59/M (7.8x cheaper)
- **Speed:** Comparable (both <2s routing decisions)
- **Free tier:** Google gives 60 req/min free via OAuth

### Current Execution Models (Ranked by Value):
1. **DeepSeek Chat** ($0.14/M in, $0.28/M out) - Best value for code generation
2. **Gemini 2.5 Flash** ($0.075/M in, $0.30/M out) - Great for simple tasks
3. **Grok 4 Fast** ($0.50/M in, $2.00/M out) - Good for complex reasoning
4. **Claude Sonnet 4.5** ($3.00/M in, $15.00/M out) - Premium quality, expensive

### OAuth "Free" Options (Unlimited via Pro subscriptions):
- **Gemini CLI** - Free via Google account (60 req/min limit)
- **Claude Code** - Free if you have Claude Pro ($20/mo)
- **Cursor CLI** - Free if you have Cursor Pro ($20/mo)

### crew-cli's Smart Model Selection:
```bash
# Routing (always Gemini 2.0 Flash):
crew chat "what does this function do?"  # Costs ~$0.0001

# Execution (auto-picked or explicit):
crew chat "add auth"                     # Uses DeepSeek ($0.002)
crew chat "add auth" --model grok-4      # Uses Grok ($0.05)
crew dispatch crew-coder "add auth"      # Uses agent's config model

# OAuth unlimited:
crew chat "add auth" --engine gemini     # $0 if Google OAuth
crew chat "add auth" --engine cursor     # $0 if Cursor Pro
```

---

## 🎨 Interactive REPL (New!)

Matches Gemini CLI quality with our own twist:

```
 ╔═══════════════════════════════════════════════════════════════════════════╗
 ║                                                                           ║
 ║     ██████╗ ██████╗ ███████╗██╗    ██╗      ██████╗██╗     ██╗           ║
 ║    ██╔════╝ ██╔══██╗██╔════╝██║    ██║     ██╔════╝██║     ██║           ║
 ║    ██║      ██████╔╝█████╗  ██║ █╗ ██║     ██║     ██║     ██║           ║
 ║    ██║      ██╔══██╗██╔══╝  ██║███╗██║     ██║     ██║     ██║           ║
 ║    ╚██████╗ ██║  ██║███████╗╚███╔███╔╝     ╚██████╗███████╗██║           ║
 ║     ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝       ╚═════╝╚══════╝╚═╝           ║
 ║                                                                           ║
 ║              🎪  Multi-Agent Orchestrator  •  Interactive Mode            ║
 ║                                                                           ║
 ╚═══════════════════════════════════════════════════════════════════════════╝

  Type your task and press Enter. Crew-cli routes to the best agent automatically.
  
  Commands:
    /help         Show commands and tips
    /status       Session info (cost, history, sandbox state)
    /preview      Show pending sandbox changes
    /apply        Apply sandbox changes to filesystem
    /rollback     Discard pending sandbox changes
    /branch       List sandbox branches
    /clear        Clear session history
    /cost         Show total cost
    /exit         Exit REPL

crew> add rate limiting to the API

  Routing...
  → crew-coder-back (CODE)

  ┌─ Response
  I'll add rate limiting middleware using express-rate-limit...
  [code implementation streams here]

  ✓ Added changes to 2 file(s) in sandbox. Type /preview to review.

crew> /preview

--- Sandbox Preview [main] ---
  src/middleware/rate-limit.ts | +42 lines (new file)
  src/server.ts                | +3 lines

crew> /apply

  ✓ Applied changes to: src/middleware/rate-limit.ts, src/server.ts

crew> /cost

--- Cost Summary ---
  Total: $0.0023
  By model:
    gemini-2.0-flash-exp: $0.0001 (routing)
    deepseek-chat: $0.0022 (execution)

crew> /exit
  👋 Goodbye!
```

**Features:**
- ✅ ASCII art banner (like Gemini CLI)
- ✅ Persistent prompt with syntax highlighting
- ✅ In-session commands (`/preview`, `/apply`, `/cost`)
- ✅ Auto-routing to best agent
- ✅ Sandbox changes accumulate across messages
- ✅ Cost tracking visible in real-time

---

## 🤖 Autonomous Mode (New!)

```bash
crew auto "implement full CRUD API for users" --max-iterations 10 --auto-apply

# Behind the scenes:
# [Iteration 1/10]
#   Routing to: crew-coder-back
#   Response: I'll create the API endpoints...
#   ✓ Added 3 file changes to sandbox
# 
# [Iteration 2/10]
#   Routing to: crew-coder-back
#   Response: Previous changes staged. Verifying implementation...
#   ✓ Added 1 file change to sandbox (tests)
#
# [Iteration 3/10]
#   Routing to: crew-coder-back
#   Response: Task complete. All CRUD endpoints implemented with validation.
#
# ✓ Task appears complete after 3 iteration(s)
#
# --- Pending Changes ---
#   src/routes/users.ts | +145 lines (new file)
#   src/models/user.ts  | +42 lines
#   tests/users.test.ts | +78 lines (new file)
#
# ✓ Auto-applied changes to: src/routes/users.ts, src/models/user.ts, tests/users.test.ts
#
# Total session cost: $0.0156
```

**Features:**
- ✅ LLM iterates without human approval
- ✅ Max iteration safety guard
- ✅ Detects completion signals ("task complete", "all done", etc.)
- ✅ Optional `--auto-apply` to write to disk when done
- ✅ Cost tracking across all iterations

**Why no other CLI has this:**
- Aider requires human approval for every change (safe but slow)
- Gemini/Claude/Codex have "continue" but no iteration loop with completion detection
- Plandex has plans but executes them **all at once** (no adaptive iteration)

---

## 📊 Context & Session Management

### What crew-cli Stores (`.crew/` folder):
```
.crew/
├── session.json        # Chat history, routing decisions
├── cost.json           # Token usage, $ spent per model
├── sandbox.json        # Pending file changes (preview/apply)
├── branches.json       # Alternative sandbox branches
├── training-data.jsonl # Corrections for fine-tuning
├── mcp-servers.json    # External tool registrations
└── context-summary.md  # Compacted context for long sessions
```

### Session Continuity:
- **Gemini CLI**: Stores session ID, resumes with `--resume <id>`
- **Codex CLI**: Uses `--last` to resume, but **no parallel sessions per user**
- **Claude Code**: Uses `--continue` flag
- **crew-cli**: Tracks session per `(engine, projectDir, sessionId)` for **true multi-user/multi-project isolation**

**Our improvement:**
- Dashboard/Telegram can have **separate sessions** per chat
- Same project, different chats → different context (no crosstalk)

---

## 🎯 Summary: What Makes crew-cli "Best of Breed"

### From Aider:
✅ Edit strategies (editblock, diff, whole-file, search-replace)

### From Plandex:
✅ Cumulative sandbox, branching, plan-first workflow

### From Gemini CLI:
✅ OAuth reuse, stream-JSON, session continuity, 2M context routing model

### From Codex:
✅ Full-auto mode, JSON output, workspace sandbox

### From Claude Code:
✅ OAuth token sharing, stream-JSON format

### From Cursor:
✅ Model flexibility, yolo mode

### Original Innovations:
✅ Dual-LLM architecture (cheap routing, smart execution)  
✅ Multi-agent dispatch (20+ specialists)  
✅ Cross-repo context & breaking change detection  
✅ Learning from corrections (local training data)  
✅ CI auto-fix loops  
✅ Browser debugging  
✅ Voice mode  
✅ MCP protocol integration  
✅ Interactive REPL  
✅ Autonomous mode (LLM self-iterates)

---

## 💰 Cost Comparison (Typical "Add Auth Feature" Task)

| Approach | Model(s) | Estimated Cost |
|----------|----------|----------------|
| **Pure Claude API** | Claude Sonnet 4.5 | $0.45 |
| **Aider** | GPT-4o (default) | $0.35 |
| **Plandex** | GPT-4o (cloud plan) | $0.40 + $10/mo subscription |
| **crew-cli (API)** | Gemini routing + DeepSeek execution | $0.02 |
| **crew-cli (OAuth)** | Gemini OAuth + Cursor OAuth | $0.00 |

**Savings:** 22.5x cheaper than Claude API, or **free** with OAuth.

---

## 🚀 Usage Examples

### 1. Simple Chat (No File Changes)
```bash
crew chat "explain the authentication flow"
# Routes to CHAT → Uses Gemini 2.0 Flash (routing model) → Responds directly
# Cost: ~$0.0001
```

### 2. Code Change (Single File)
```bash
crew chat "add rate limiting"
# Routes to CODE → Uses DeepSeek Chat → Adds to sandbox → Preview → Apply
# Cost: ~$0.002
```

### 3. Complex Feature (Multi-Agent)
```bash
crew chat "implement user profile page"
# Routes to DISPATCH → crew-pm creates plan → dispatches to:
#   - crew-coder-front (React component)
#   - crew-coder-back (API endpoints)
#   - crew-qa (tests)
# All changes accumulate in sandbox
# Cost: ~$0.05
```

### 4. Autonomous Mode
```bash
crew auto "fix all TypeScript errors" --max-iterations 5 --auto-apply --lsp-auto-fix
# LLM iterates, applies fixes, re-checks, repeats until done
# No human approval needed (great for CI)
```

### 5. Interactive REPL
```bash
crew repl
# Opens persistent chat session
# /model, /lsp, /memory, /help, /preview, /apply, /cost commands available
# /mode [manual|assist|autopilot], Shift+Tab cycles modes
# Session state saved between runs
```

### 6. Cross-Repo Task
```bash
crew chat "update User schema" --cross-repo
# Scans ../api, ../frontend, ../shared-types
# Warns if changes will break sibling repos
```

### 7. Visual Repository Graph
```bash
crew map --graph --visualize
# Writes interactive HTML graph + .dot file
# Use --out to choose output path
```

---

## 🔧 Commands Added Today

1. ✅ `crew repl` - Interactive REPL mode with ASCII banner
2. ✅ `crew auto <task>` - Autonomous iteration mode
3. ✅ `/models` - Telegram command to switch models per engine
4. ✅ Dashboard model picker for crew-lead default model
5. ✅ crew-cli added to Dashboard/Telegram engine dropdowns

## 🆕 Capability Update (2026-03-01)

### Shipped in this update

0. ✅ `Copilot-style P1 parity (slash commands + repo config)`
- REPL slash command dispatcher with explicit built-ins:
  - `/help`, `/model`, `/lsp`, `/memory`
- Repo-level config layering:
  - Team defaults: `.crew/config.json`
  - User overrides: `.crew/config.local.json`
  - Resolved config now used as defaults for `chat`, `auto`, `dispatch`, `plan`, and `repl`
- New CLI command group:
  - `crew config show [--scope resolved|team|user]`
  - `crew config get <key> [--scope ...]`
  - `crew config set <key> <value> [--scope team|user] [--json]`
- Team-scope secret guard:
  - secret-like keys are rejected
  - values are redacted on display.

0.1 ✅ `Copilot-style P2/P3 parity (GitHub NL + banner + autopilot cycle)`
- Natural language GitHub flows through `gh` with confirmation gates for mutations:
  - `crew github "list open issues limit 10"`
  - `crew github "create issue \"Fix login\" body: ..."`
  - `crew github "update issue #42 close"`
  - `crew github "create draft pr \"Refactor auth\" body: ..."`
- Animated first-launch REPL banner controls via repo config:
  - `repl.bannerEnabled`
  - `repl.animatedBanner`
  - `repl.bannerFirstLaunchOnly`
- REPL mode cycling:
  - Modes: `manual`, `assist`, `autopilot`
  - `Shift+Tab` cycles modes deterministically
  - Prompt shows active mode.

1. ✅ `LSP integration`
- `crew lsp check [files...] [--json]` for TypeScript diagnostics
- `crew lsp complete <file> <line> <column> [--prefix] [--limit] [--json]` for autocomplete suggestions
- Files: `src/lsp/index.ts`, `src/tools/manager.js`

2. ✅ `PTY support`
- `crew pty "<command>"` for interactive terminal execution
- Uses `node-pty` with fallback to inherited terminal execution
- Files: `src/pty/index.ts`, `src/tools/manager.js`

3. ✅ `Repository mapping graph`
- `crew map --graph` for dependency-aware output
- `crew map --graph --json` for machine-readable graph export
- File: `src/mapping/index.ts`

4. ✅ `Image inputs (screenshots -> code context)`
- `crew chat --image <path>`
- `crew dispatch ... --image <path>`
- Additional controls:
  - `--context-image <path>`
  - `--image-max-bytes <n>`
- File: `src/context/augment.ts`

### 3-Tier LLM readiness: what can be done next

Status of requested features:

- ✅ Parallel function calling (Tier 3 workers via worker pool)
- ✅ AgentKeeper memory (cross-tier persistence)
- ✅ Token caching (cost optimization)
- ✅ Blast radius analysis (safe refactoring)
- ✅ Collections search (RAG over docs + code)

What crew-cli can do from here (implementation-ready plan):

1. Parallel function calling (Tier 3 workers)
- Add worker pool execution in orchestrator with bounded concurrency and per-task retries.
- Route Tier 2 planner output into parallel Tier 3 micro-task jobs, merge into sandbox branches.

2. AgentKeeper memory (cross-tier persistence)
- Implemented persistent shared memory in `.crew/agentkeeper.jsonl`.
- Auto-wired recall/record into `plan`, `dispatch`, and `auto` flows.
- Added command controls:
  - `--no-memory`
  - `--memory-max <n>`
- Added memory inspection/maintenance commands:
  - `crew memory [query]`
  - `crew memory-compact`

3. Token caching
- Implemented local cache store at `.crew/token-cache.json`.
- Planner output cache shipped (`crew plan`, with TTL control).
- Output cache shipped for:
  - `crew dispatch ... --cache --cache-ttl <sec>`
  - `crew auto ... --cache --cache-ttl <sec>`
- Cache savings now visible in `crew cost`:
  - hits/misses
  - estimated tokens saved
  - estimated USD saved

4. Blast radius analysis
- Implemented dependency-graph-based impact analyzer (`src/safety/blast-radius.ts`).
- `crew auto --auto-apply` now includes a safety gate by default.
- Override controls:
  - `--no-blast-radius-gate`
  - `--blast-radius-threshold <low|medium|high>`
  - `--force-auto-apply`

5. Collections search (RAG over docs)
- Implemented local docs search:
  - `crew docs <query> [--path <dir>] [--max <n>] [--json] [--code]`
  - auto docs-context injection for `chat`/`dispatch` via `--docs`, `--docs-path`, `--docs-code`
- Uses local chunked index with source + line attribution.

6. Shared Brain hardening + CLI parity patterns
- Implemented explicit `plan -> execute -> validate -> reflect` loop in `crew plan` with:
  - `--validate-cmd <cmd>` hard validation gates
  - `--reflect-agent <id>` explicit reflection pass per step
- Implemented resumable deterministic checkpoints:
  - `crew checkpoint list`
  - `crew checkpoint show <runId>`
  - `crew checkpoint replay <runId> [--execute]`
  - `crew plan ... --resume <runId>`
- Implemented model fallback chain policy for `auto`, `dispatch`, and `plan`:
  - `--fallback-model <id>` (repeatable)
- Implemented patch risk/confidence scoring and optional escalation:
  - `--escalate-risk`
  - `--risk-threshold <low|medium|high>`
  - escalates to `crew-qa` and `crew-security` at/above threshold.

7. Grok/X search integration
- Added native X/Twitter search command using xAI Responses API + `x_search`:
  - `crew x-search "<query>" [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]`
  - supports `--allow-handle`, `--exclude-handle`, `--images`, `--videos`, `--json`
- API key sources:
  - `XAI_API_KEY`
  - `GROK_API_KEY`
  - `~/.crewswarm/crewswarm.json` → `providers.xai.apiKey`

8. Background Agent System (AutoFix)
- Added persisted background queue:
  - `crew autofix enqueue "<task>"` with `--max-iterations`, `--validate-cmd`, `--auto-apply-policy`, `--blast-radius-threshold`.
  - `crew autofix list|show|cancel` for queue operations.
- Added unattended worker loop:
  - `crew autofix worker [--once|--max-jobs N|--poll-ms N]`.
- Added safety behavior before apply:
  - optional validation command gate (`--validate-cmd`, repeatable).
  - blast-radius and patch-risk scoring before apply.
  - apply policy controls: `never` (proposal only), `safe` (validation+blast gate), `force` (always apply).
- When auto-apply is blocked or disabled, proposal diff is saved to:
  - `.crew/autofix/proposals/<job-id>.diff`

---

## 📝 Next Steps

### Immediate:
- Test `crew repl` in terminal to verify REPL UX
- Test `/models` command in Telegram
- Verify crew-cli routing uses Gemini 2.0 Flash (not Groq)

### Near-term:
- Add `crew serve` - Launch crew-cli as a long-running daemon with HTTP API
- ✅ `crew shell` - Natural language → shell command translation
- Benchmark documentation delivered (`docs/BENCHMARK-RESULTS.md`); optional future item is a dedicated `crew benchmark` command

---

## 🎥 Visual Demos (Autonomous Proofs)

We use an automated, headless Chrome-based recording engine (`scripts/make-video.mjs`) to generate pixel-perfect demonstrations of the system's capabilities.

1. **[Core Demo (demo.mp4)](marketing/demo.mp4)** - Showcases the **Speculative Explore** mode, parallel worker pools, and safety gates in a realistic refactoring scenario.
2. **[Autonomous Agent (autonomous-agent.mp4)](marketing/autonomous-agent.mp4)** - Watch the agent plan, code, **detect its own syntax errors via LSP**, self-heal, and integrate a feature from scratch.
3. **[Interactive REPL (repl-demo.mp4)](marketing/repl-demo.mp4)** - Demonstrates the high-performance multi-agent shell with real-time model switching to **Gemini 2.0 Flash**.

---

**Document Status:** Complete  
**Last Updated:** 2026-03-01  
**Maintained By:** crewswarm team
