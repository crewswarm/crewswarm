# Brain — Project Knowledge

Agents: append discoveries here. This is the persistent knowledge base for this workspace.
Read it to avoid repeating mistakes. Write to it when you learn something durable.

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
- `groq/openai/gpt-oss-120b` — returns empty string, silently broken
- `groq/openai/gpt-oss-20b` — same, empty responses

**Google Gemini key: free tier only** — hits 429 rate limit immediately under agent load. Not usable for production agents without upgrading to paid Google AI Studio billing.

**Current role → model assignment (as of 2026-02-26):**
- EXECUTOR (coders/fixer): kimi-k2-instruct-0905 + opencode/claude-sonnet-4-5 via OpenCode
- THINKER (pm/architect/ml): deepseek/deepseek-reasoner — focused reasoning, no token runaway
- COORDINATOR (main/lead/orchestrator): xai/grok-3-mini
- ANALYST (qa/security/mega): deepseek/deepseek-chat
- SIMPLE (github/copywriter/telegram/seo): groq/llama-3.3-70b-versatile
- RESEARCHER: perplexity/sonar

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
