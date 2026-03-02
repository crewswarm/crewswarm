# Brain — Project Knowledge

Agents: append discoveries here. This is the persistent knowledge base for this workspace.
Read it to avoid repeating mistakes. Write to it when you learn something durable.

## [2026-02-27] system: crew-mega capabilities + Polymarket strategy

**crew-mega** is the generalist heavy-hitter agent — use it for tasks that require broad context, deep reasoning, or multiple capability types in a single session. It runs Claude Code by default (`useClaudeCode: true`) so it has full file-read/write access.

**Model setup:**
- Primary: `deepseek/deepseek-chat` (fast, cheap, capable)
- Fallback: `deepseek/deepseek-reasoner` (o1-style deep reasoning for hard problems)
- Claude Code engine: `opencode/claude-sonnet-4-6`

**Best uses for crew-mega:**
- Multi-file refactors that cross several modules
- Strategy analysis (especially Polymarket prediction markets)
- Tasks that don't fit neatly into coder/qa/pm roles
- When other agents keep failing and you need a generalist

**Polymarket strategy tips (for when crew-mega analyzes markets):**
- Check liquidity and spread before entering — low-liquidity markets have wide spreads that eat alpha
- Calibration beats prediction: focus on identifying where market prices deviate from true probability
- Consensus anchoring: Polymarket crowds over-anchor to 50/50 on contested events; exploit systematic under-pricing of strong favorites and strong underdogs
- Time decay: YES/NO prices compress toward terminal value as resolution nears — trade this intentionally
- Resolution risk: always read the exact resolution criteria before buying — ambiguity is a trap

## [2026-02-28] system: Grok/xAI integration — advanced capabilities

**Provider:** xAI (https://console.x.ai/) — base URL `https://api.x.ai/v1` (OpenAI-compatible)

**Models:**
- `xai/grok-beta` — 128K context, real-time X/Twitter access, function calling
- `xai/grok-vision-beta` — multimodal (text + images), 128K context
- `xai/grok-3-mini` — fast coordinator, confirmed working (see model roster above)
- `xai/grok-3` — full model (replaced by deepseek-chat for cost efficiency in most roles)

**Unique capabilities vs other providers:**
1. **Real-time X/Twitter integration** — Grok can search and retrieve live tweets, trends, and social conversations. No other LLM has this natively.
2. **Vision** — grok-vision-beta analyzes images (JPEG, PNG, WebP, GIF up to 20MB). Competitive with GPT-4V and Claude 4 Vision.
3. **128K context** — larger than most providers (Groq: 32K, Mistral: 32K, Cerebras: 8K). Same as Claude/GPT-4.
4. **Function calling** — OpenAI-compatible tool use (not yet exposed in CrewSwarm skills, but supported by the API).

**New skills (2026-02-28):**
1. **grok.x-search** — Search Twitter/X in real-time. Returns tweet summaries, author mentions, trending context.
   - Aliases: `x-search`, `twitter-search`, `grok-search`
   - No approval required (read-only)
   - 30s timeout
   - Example: `@@SKILL grok.x-search {"query": "What are developers saying about Cursor AI this week?"}`

2. **grok.vision** — Analyze images with Grok Vision.
   - Aliases: `grok-vision`, `vision`, `image-analysis`
   - Supports: JPEG, PNG, WebP, GIF (non-animated), max 20MB
   - No approval required
   - 45s timeout
   - Example: `@@SKILL grok.vision {"image_url": "https://example.com/ui-screenshot.png", "prompt": "Is this UI accessible? Check contrast ratios."}`

**When to use Grok over other models:**
- **crew-researcher + grok.x-search:** Track competitor launches, product sentiment, trending topics on X
- **crew-copywriter + grok.x-search:** Research viral tweet patterns, hashtag performance for content strategy
- **crew-qa + grok.vision:** Automated UI screenshot testing, visual regression detection
- **crew-security + grok.vision:** Analyze phishing images, suspicious documents, identity verification
- **crew-pm + grok.x-search:** Gather user feedback and feature requests from social media
- **crew-seo + grok.x-search:** Monitor brand mentions, backlink opportunities, influencer reach

**Cost comparison (as of 2026-02-28):**
- grok-beta: ~$5/M input, ~$15/M output (mid-tier pricing, justified by X access)
- grok-vision-beta: ~$10/M input, ~$30/M output (image tokens cost more)
- Alternative for pure text: deepseek-chat ($0.27/$1.10) or groq/llama-3.3-70b (free tier)
- Alternative for vision: OpenAI GPT-4V or Claude 4 Vision (similar pricing, no X access)

**Configuration example:**
```json
// ~/.crewswarm/crewswarm.json
{
  "providers": {
    "xai": {
      "apiKey": "xai-..."
    }
  },
  "agents": [
    {
      "id": "crew-researcher",
      "model": "xai/grok-beta",
      "tools": {
        "crewswarmAllow": ["read_file", "write_file", "skill"]
      }
    }
  ]
}
```

**Skills are auto-discovered** from `~/.crewswarm/skills/*.json` — no agent config changes needed to use grok.x-search or grok.vision.

## [2026-02-27] system: crew-lead chat history architecture (current)

- **Disk storage:** `~/.crewswarm/chat-history/<sessionId>.jsonl` — stores up to 2000 messages per session, indefinitely across browser sessions
- **LLM context:** Full history sent to LLM on every call — no artificial message cap. Models handle 64k–1M tokens; history only truncates if the model's actual token limit is hit (rare)
- **No context warnings:** The old 40-message "context nearly full" warning was removed. Context never "fills up" from our side.
- **@@RESET** still works to clear history and start fresh if desired
- **@@SEARCH_HISTORY <query>** — searches all session history files by keyword. Returns up to 20 matching lines with timestamps. Use when user asks about past conversations or old decisions.
- **Session memory injection:** On first message of a new session (history.length === 0), brain.md + lessons.md + decisions.md + global-rules.md are injected as a system message. Subsequent messages load them from disk history — no re-read needed.

## [2026-02-26] system: Cursor CLI + OpenCode session continuity

**Cursor CLI (`agent` binary):**
- Install: `curl https://cursor.com/install -fsS | bash` → installs to `~/.local/bin/agent`
- Logged in as jeffhobbs9@gmail.com — subscription active
- Non-interactive usage: `agent -p --force --trust --output-format stream-json "task"`
- **Known bug (Feb 2026):** `-p` print mode never exits after completing task. Workaround: use `--output-format stream-json` and kill on `{"type":"result"}` event.
- **Session continuity:** `agent --resume=<chatId>` continues a previous chat. `agent ls` lists chats. `agent create-chat` creates a new one.
- **Available models (all free via Cursor subscription):**
  - `opus-4.6-thinking` — Claude 4.6 Opus with thinking (DEFAULT, most capable)
  - `sonnet-4.6` / `sonnet-4.6-thinking` — Claude 4.6 Sonnet
  - `gpt-5.3-codex` / `gpt-5.3-codex-high` — OpenAI Codex
  - `gemini-3.1-pro`, `gemini-3-flash` — Google Gemini 3
  - `grok` — xAI Grok
- **In CrewSwarm:** enable via `useCursorCli: true` in `~/.crewswarm/crewswarm.json` per agent. Falls back to OpenCode on failure.
- **Session files:** `~/.crewswarm/sessions/<agentId>.cursor-session` (alongside `.session` for OpenCode)

**OpenCode session continuity (implemented 2026-02-26):**
- `opencode run -s <sessionId>` continues from previous session
- Session IDs stored in `~/.crewswarm/sessions/<agentId>.session`
- Race condition fix: filter by `[agentId]` prefix in session title (prompts are prefixed)
- Dashboard "Reset context window" clears BOTH OpenCode and Cursor sessions
- `gateway-bridge --reset-session <agentId>` to clear manually

## [2026-02-26] system: verified model roster + pricing (tested live via API)

**Working models (confirmed via API call):**
- `groq/moonshotai/kimi-k2-instruct-0905` — best cheap coder, ~76% SWE-bench, $1/$3 per M
- `groq/moonshotai/kimi-k2-instruct` — same model, alternate ID
- `groq/qwen/qwen3-32b` — works but DANGEROUS: extended thinking causes 100M+ token burns. Do not use without strict step/token limits.
- `deepseek/deepseek-chat` (V3) — fast, $0.27/$1.10 per M, great for coordination/analysis
- `deepseek/deepseek-reasoner` (R1) — focused reasoning, $0.55/$2.19 per M, replaces Qwen for planning roles
- `xai/grok-3-mini` — fast coordinator, confirmed working
- `xai/grok-3` — full model, confirmed working (now replaced by deepseek-chat for cost)
- `perplexity/sonar` — web-search built-in, confirmed working
- `opencode/claude-sonnet-4-5` — best coding quality, accessed via OpenCode subscription (API prices + markup)
- `groq/llama-3.3-70b-versatile` — reliable, free-tier friendly, good for simple tasks

**Broken / do not use:**
- `groq/openai/gpt-oss-120b` — Groq's proxy returns empty string. NEVER assign as fallback. Direct via OpenAI key (`openai/gpt-oss-120b`) or OpenCode (`opencode/gpt-oss-120b`) may work fine.
- `groq/openai/gpt-oss-20b` — same, Groq proxy broken. Direct OpenAI/OpenCode routes may work.
- `gpt-5` (bare, without opencode/ prefix) — not a real routable model outside OpenCode. Use `opencode/gpt-5` or `opencode/gpt-5-nano` for OpenCode routes.
- `groq/openai/gpt-oss-20b` — same, empty responses

**Google Gemini key: PAID tier** — upgraded. `google/gemini-2.5-flash` confirmed working for crew-lead; `reasoning_effort: "none"` required to suppress hidden thinking tokens that burn TPM quota. `max_tokens` bumped to 16384. Excellent for conversational routing.

**Current role → model assignment (as of 2026-02-26):**
- EXECUTOR (coders/fixer): kimi-k2-instruct-0905 + opencode/claude-sonnet-4-5 via OpenCode
- THINKER (pm/architect/ml): deepseek/deepseek-reasoner — focused reasoning, no token runaway
- COORDINATOR (main/lead/orchestrator): xai/grok-3-mini
- ANALYST (qa/security/mega): deepseek/deepseek-chat
- SIMPLE (github/copywriter/telegram/seo): groq/llama-3.3-70b-versatile
- RESEARCHER: perplexity/sonar
- **SOCIAL_INTEL (new):** xai/grok-beta with grok.x-search skill — real-time Twitter/X monitoring, trend analysis, sentiment tracking
- **VISION (new):** xai/grok-vision-beta — image analysis, UI testing, document OCR, accessibility audits

**Battle-tested crew-lead models (2026-02-26, live user validation):**
- `xai/grok-3-mini` ✅ — fast, reliable coordinator, great for conversational routing
- `deepseek/deepseek-chat` ✅ — solid crew-lead, good at tool syntax, cost-effective
- `google/gemini-2.5-flash` ✅ — excellent after fixes: reasoning_effort=none, max_tokens=16384, strip fallback banners from history. Needs concrete @@ tool examples in prompt (not placeholders like `<cmd>`).
- All three handle dispatch, tool calls, and conversation well. Rotate freely.

## [2026-02-25] system: opencode --attach implemented

- `opencode run --attach http://127.0.0.1:<port>` eliminates per-run MCP server cold boot.
- `start-crew.mjs` checks port 4096 first (started by restart-all). If not up, starts a fresh headless serve on 4097.
- `gateway-bridge.mjs` probes `/global/health` before each run; if healthy, adds `--attach <url>` to the opencode args.
- No password needed — serve only listens on 127.0.0.1 (loopback-only, trusted local access).
- **Key finding**: `opencode run --attach` only works when stdin is NOT a terminal (i.e., closed/piped). The bridge always uses `stdio: ["ignore", "pipe", "pipe"]` so this is handled automatically.
- **Key finding**: URL-embedded basic auth (`http://user:pass@host`) causes "Session not found" on opencode serve — do NOT use a password with --attach.
- `--format json` was NOT implemented — the raw event schema is undocumented and the existing text parsing works fine.

## Format

```
## [YYYY-MM-DD] agent-name: one-line title
Key fact or decision. Max 3 sentences. Be specific — no fluff.
```

---

## [2026-02-25] system: background consciousness (crew-main between tasks)
- When `CREWSWARM_BG_CONSCIOUSNESS=1`, crew-lead dispatches **crew-main** every 15 min (or CREWSWARM_BG_CONSCIOUSNESS_INTERVAL_MS) when no pipelines are active.
- Task: read brain.md, one-sentence system/crew state, optionally one @@BRAIN or @@DISPATCH else NO_ACTION. Ouroboros-style "thinks between tasks"; keeps crew proactive.
- crew-main manages the process for the user: his reply is shown in owner chat and written to **~/.crewswarm/process-status.md** so the user (or dashboard) can see status and next steps.

## [2026-02-25] system: project directory rule
- Never assume a project directory. Always use the path explicitly provided in the task. If no project path is given, ask before writing any files.
- Never use `/Users/jeffhobbs/Desktop/CrewSwarm/<project-name>/` as an output directory for external projects.

## [2026-02-22] system: CrewSwarm repo facts
- Repo lives at `/Users/jeffhobbs/Desktop/CrewSwarm/`
- The RT bus runs on `ws://localhost:18889`; crew-lead HTTP on `http://localhost:5010`; dashboard on `http://localhost:4319`
- All agent tool permissions live in `~/.crewswarm/crewswarm.json` → `agents[].tools.crewswarmAllow`

## [2026-02-22] crew-coder: tool call rules that work
- Output ALL tool calls in ONE reply — never stop after @@MKDIR and wait for a response.
- @@END_FILE must be on its own line with no trailing content; the regex will miss it otherwise.
- The directory for a new file should already exist or be created with @@MKDIR in the same reply, before @@WRITE_FILE.

## [2026-02-22] system: shared memory loading order
- SHARED_MEMORY_FILES loaded into every prompt: current-state.md, agent-handoff.md, orchestration-protocol.md
- telegram-context.md and decisions.md are NOT loaded into task prompts (too noisy)
- brain.md (this file) IS loaded — keep entries brief; it will grow

## [2026-02-23] system: dashboard edits — always run check script
- **Every** change to `scripts/dashboard.mjs` must be followed by `node scripts/check-dashboard.mjs`. Dashboard updates frequently break the inline script (nested quotes, template literals); the check prints the exact line that breaks.
- If the full check hangs, use `node scripts/check-dashboard.mjs --source-only`.

## [2026-02-24] system: design standards — all frontend agents must follow
- Typography: system font stack or Inter. 16-18px body, 1.5 line-height. Weight hierarchy 400/500/600/700.
- Spacing: 8px grid. Section padding 48-96px. Cards 24-32px internal. Use CSS `gap`.
- Color: muted neutrals + one accent. Dark mode via `--color-*` custom properties. Never pure #000 or #fff.
- Corners: 8px cards, 12px modals, 24px hero sections. Consistent per element type.
- Shadows: layered — sm `0 1px 2px`, md `0 4px 16px`, lg `0 12px 48px`. `rgba(0,0,0,0.06-0.12)`.
- Motion: 200-300ms ease-out. Fade + translateY(8px→0) for reveals. Respect `prefers-reduced-motion`.
- Layout: mobile-first. Breakpoints 640/768/1024/1280px. Max-width 1200px centered. CSS Grid for pages, Flexbox for components.
- Accessibility: semantic HTML (nav, main, section, article, footer). focus-visible, 4.5:1 contrast, aria-labels, skip-nav.
- No hard borders. Separate sections with background shifts or 1px opacity-0.1 dividers.

## [2026-02-24] system: reference sites
- Apple HIG: https://developer.apple.com/design/human-interface-guidelines
- OWASP Top 10: https://owasp.org/Top10/2025/ | Cheat Sheets: https://cheatsheetseries.owasp.org
- Model benchmarks: `memory/model-ratings.md` (CrewSwarm repo). Groq coding rank: kimi-k2-instruct > gpt-oss-120b > llama-3.3-70b.

## [2026-02-24] system: coding standards — all coder agents
- ES modules (import/export), async/await, no callbacks.
- Error handling: try/catch all async ops, validate inputs, guard nulls before property access.
- Database: parameterized queries (never string interpolation), connection pooling.
- Auth: never plaintext passwords. bcrypt/argon2. JWT with short expiry + refresh tokens.

## [2026-02-24] crew-lead: dispatch reliability rules
- ALWAYS emit a literal `@@DISPATCH {"agent":"...","task":"..."}` line when dispatching. Never just say "I'll dispatch" without the actual marker.
- QA output file is always `qa-report.md`, never `qa-results.md` or `qa-output.md`.
- When dispatching to ANY agent, include specific files to check and output file path — but ONLY include a project path if one was explicitly provided by the user or is the active project in the dashboard. Never invent or assume a project path.

## [2026-02-25] system: self-commit multi-model review — REQUIRED when enabled
- When crew-github targets the CrewSwarm repo itself, NO commit may land without 2+ of (o3, gemini-2.5-pro, claude-opus) approving first.
- NOT needed for external project commits (polymarket, llm-trading-api, etc.) — only CrewSwarm self-modification.

## [2026-02-25] QA + dispatch: ALWAYS discover project structure before auditing
- QA must run `@@RUN_CMD find /project -name "*.py"` first if paths are unknown — never assume flat structure.
- When QA says "file not found", fix the PROMPT not the dispatch.

## [2026-02-26] system: agent failure patterns — universal rules
- **"Fixed" lie**: Agents claim success without running verification. Every task MUST end with a @@RUN_CMD that executes the code and shows real output. No exceptions.
- **Half-job completion**: When replacing any function call, grep ALL call sites first, fix every one — never fix one instance and stop.
- **Type/method blindness**: Before calling any function from an imported module, @@READ_FILE that module and verify the method exists by exact name and argument types match.
- **OpenCode "file not found" lie**: OpenCode frequently reports "file does not exist" for files that DO exist. Verify with `@@RUN_CMD ls -la /path/to/file`.
- **Config cost bomb**: A global model override in `~/.opencode/config.json` with high step count can burn 100M+ tokens in one session. Check that file before starting any long-running agent loop.

## [2026-02-26] system: READ-BEFORE-WRITE — hard rule for all agents
- Before creating or modifying ANY file, @@READ_FILE every relevant existing file first. If the needed functionality already exists, reply "no-op" — do NOT create a duplicate.
- @@READ_FILE the target module before adding any import. If the symbol is missing, abort rather than inventing a new file.


## [2026-02-27] system: new capabilities built — Ouroboros loop, central brain, engine passthrough

### Ouroboros loop — all 3 engines (gateway-bridge.mjs)
- `runOuroborosStyleLoop(task, agentId, projectDir, payload, progress, engine)` — shared loop for all engines
- `engine` param: `"opencode"` | `"cursor"` | `"claude"` — selects which binary runs each step
- Central loop brain: `crewswarm.json → loopBrain: "groq/llama-3.3-70b-versatile"` — one fast model controls STEP/DONE for ALL agents across all engines. Falls back to agent's own model if not set.
- Per-agent config: `opencodeLoop: true` + `opencodeLoopMaxRounds: 10` in crewswarm.json
- Dashboard: Agents tab → per-agent 🔁 Ouroboros Loop checkbox + max rounds (shows when any coding engine is selected)
- Dashboard: Settings → System → OpenCode Loop section → 🧠 Central loop brain input field
- Loop progress visible in chat: `[Cursor CLI loop] Loop brain: llama-3.3-70b-versatile (central brain) | Engine: Cursor CLI | Max 10 rounds`

### Engine passthrough — direct chat to any coding engine (crew-lead.mjs)
- `POST /api/engine-passthrough` — body: `{ engine, message, projectDir }` — streams output as SSE
- On completion: broadcasts `agent_reply` to dashboard SSE + sends TG notification if configured
- Dashboard: Chat tab → "⚡ Direct engine" dropdown below input — pick Claude Code / Cursor CLI / OpenCode
- When active: messages bypass crew-lead entirely, go straight to the binary, stream back live in monospace bubble
- Route: dashboard proxy (`/api/engine-passthrough`) → crew-lead `:5010` → engine binary

### MCP server — CrewSwarm as MCP server for Cursor/Claude/OpenCode
- 13 tools exposed at `http://127.0.0.1:5020/mcp`: dispatch_agent, list_agents, run_pipeline, chat_stinki, crewswarm_status, smart_dispatch, skill_*
- Config: `~/.cursor/mcp.json` and `~/.claude/mcp.json` both pointing to port 5020
- install.sh has optional MCP setup step (6f) that auto-writes all 3 client configs
- AGENTS.md has full "MCP Integration" section with comparison table vs Cursor built-in subagents
- Website: feature card added to features grid explaining the MCP integration

### Key architecture fact — gateway-bridge.mjs was truncated
- The file on disk was a 4031-byte stub ending in `...[truncated]`. Restored from git with `git checkout HEAD -- gateway-bridge.mjs`.
- Always verify with `wc -l gateway-bridge.mjs` — should be ~5000+ lines.

## [2026-02-28] crew-main: crew-main: The recent shared memory update indicates a successful deployment of the new coding standards and guidelines.

## [2026-03-01] crew-lead: crew-lead (auto): **Never store secrets in code** - use environment variables 2

## [2026-03-02] crew-lead: crew-lead (auto): It claims everything is "✅ Complete" but: 1

## [2026-03-02] crew-lead: crew-lead (auto): json` with bin entry `crew` ✓ (already exists) - [x] Install dependencies: chalk, commander, ora, inquirer, ws ✓ (node_modules confirmed) - [x] Create basic folder structure: `src/`, `bin/`, `lib/`, `
