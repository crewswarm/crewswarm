# Brain — Project Knowledge

Agents: append discoveries here. This is the persistent knowledge base for this workspace.
Read it to avoid repeating mistakes. Write to it when you learn something durable.

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

## [2026-02-25] system: Desktop projects — never use CrewSwarm as base
- **Two separate projects:** (1) **polymarket-ai-strat** → `/Users/jeffhobbs/Desktop/polymarket-ai-strat/` (2) **llm-trading-api** → `/Users/jeffhobbs/Desktop/llm-trading-api/`. Do not conflate them.
- **Never** use `/Users/jeffhobbs/Desktop/CrewSwarm/<project-name>/` for either. Correct base is always `.../Desktop/<project-name>/`. For pip, run_cmd, or @@READ_FILE: use the Desktop path (e.g. `pip install -r /Users/jeffhobbs/Desktop/polymarket-ai-strat/requirements.txt`), never `.../CrewSwarm/polymarket-ai-strat/...`.
- polymarket-ai-strat: **main.py** at `src/api/main.py` (not `src/api/routers/main.py`). backtests: `src/api/routers/backtests.py`.

## [2026-02-25] system: crew-mega upgrade plan lives in CrewSwarm only
- **Re-implementation plan for crew-mega (QA-failed phases 1,2,4,5)** is in `/Users/jeffhobbs/Desktop/CrewSwarm/ROADMAP.md` — see section "crew-mega Upgrade (user requested 10x improvement)".
- Do NOT point people to `polymarket-ai-strat/ROADMAP.md` for crew-mega; that project's ROADMAP is Phase 4 (Strategy Persistence, Market Browser, Performance) only. CrewSwarm config work = CrewSwarm repo.

## [2026-02-22] system: CrewSwarm repo facts
- Repo lives at `/Users/jeffhobbs/Desktop/CrewSwarm/`
- The RT bus runs on `ws://localhost:18889`; crew-lead HTTP on `http://localhost:5010`; dashboard on `http://localhost:4319`
- All agent tool permissions live in `~/.crewswarm/crewswarm.json` → `agents[].tools.alsoAllow` (or `tools.crewswarmAllow` for CrewSwarm @@TOOL names)

## [2026-02-22] crew-coder: tool call rules that work
- Output ALL tool calls in ONE reply — never stop after @@MKDIR and wait for a response.
- @@END_FILE must be on its own line with no trailing content; the regex will miss it otherwise.
- The directory for a new file should already exist or be created with @@MKDIR in the same reply, before @@WRITE_FILE.

## [2026-02-22] system: shared memory loading order
- SHARED_MEMORY_FILES loaded into every prompt: current-state.md, agent-handoff.md, orchestration-protocol.md
- telegram-context.md and decisions.md are NOT loaded into task prompts (too noisy)
- brain.md (this file) IS loaded — keep entries brief; it will grow

## [2026-02-23] crew-lead: …`.

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

## [2026-02-24] system: reference sites — search these for examples and docs
### Frontend / UI
- Apple HIG: https://developer.apple.com/design/human-interface-guidelines
- Uiverse.io: 7000+ free copy-paste HTML/CSS components — search `site:uiverse.io [component]`
- CSS-Tricks: technique guides — search `site:css-tricks.com [technique]`
- MDN CSS: https://developer.mozilla.org/en-US/docs/Web/CSS/[property]
- Design inspiration: search `awwwards [page type]` or `onepagelove [page type]`
- Interactive examples: search `site:codepen.io [component] vanilla CSS`
### Backend / Node
- Node.js API: search `site:nodejs.org/api [module]`
- npm packages: search `[package name] npm documentation`
- MDN HTTP: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
### Security
- OWASP Top 10 (2025): https://owasp.org/Top10/2025/
- OWASP Cheat Sheets (91+ guides): https://cheatsheetseries.owasp.org — search `site:cheatsheetseries.owasp.org [vulnerability type]`
- CVE lookup: search `CVE [library] [version]`
### SEO
- Google structured data: https://developers.google.com/search/docs/appearance/structured-data
- Schema validator: https://validator.schema.org
- Web performance: search `site:web.dev [topic]`
### ML / AI
- HuggingFace Trainer: https://huggingface.co/docs/transformers/main/en/trainer
- PyTorch: search `site:pytorch.org/docs [module]`
- Model cards: search `site:huggingface.co/[model-name]`
- Smol Training Playbook: https://huggingfacetb-smol-training-playbook.hf.space/

## [2026-02-24] system: model ratings — when recommending models
- Full benchmarks in `memory/model-ratings.md` (CrewSwarm repo). Coding agents: @@READ_FILE that path when user asks "which model" or "ratings."
- Groq coding rank: kimi-k2-instruct-0905 (69% SWE-Bench, 93% HumanEval) > gpt-oss-120b (62%, 8.3/10) > llama-3.3-70b.

## [2026-02-24] system: coding standards — all coder agents
- ES modules (import/export), async/await, no callbacks.
- Error handling: try/catch all async ops, validate inputs, guard nulls before property access.
- Match existing code patterns and naming conventions in the project.
- Small functions, clear names, no dead code. No console.log in production.
- All config via env vars; never hardcode secrets. Validate required env vars at startup.
- Database: parameterized queries (never string interpolation), connection pooling.
- Auth: never plaintext passwords. bcrypt/argon2. JWT with short expiry + refresh tokens.

## [2026-02-24] crew-lead: if you want, but don't waste it on fluff. Who's on your hit list?

## [2026-02-24] crew-lead: When forming pipeline dispatches for QA output, use 'qa-report.md' as the correct filename convention to avoid hallucinations.

## [2026-02-24] crew-lead: dispatch reliability rules
- ALWAYS emit a literal `@@DISPATCH {"agent":"...","task":"..."}` line when dispatching. Never just say "I'll dispatch" or "dispatching now" without the actual marker — the retry catches it but costs a round-trip.
- The dispatch-lie auto-retry (when @@DISPATCH marker is missing) was broken due to `sendDispatch` not existing — fixed to use `dispatchTask`. But the real fix is to always emit the marker in the first place.
- If a dispatch fails after retry, do NOT tell the user "please ask me again" without also logging why. Check RT bus health first.
- QA output file is always `qa-report.md`, never `qa-results.md` or `qa-output.md`.

## [2026-02-25] system: self-commit multi-model review — REQUIRED when enabled
- When crew-github is pointed at the CrewSwarm repo itself (self-modification), NO commit may land without a multi-model review step first.
- Review ensemble (from Ouroboros pattern): at least 2 of — o3, gemini-2.5-pro, claude-opus — must approve before `git commit`.
- Implementation: add a review wave BEFORE crew-github in any self-mod pipeline. Dispatch the diff to 2+ review agents; only proceed if both approve. Rejection = back to crew-coder with feedback.
- This is NOT needed for external project commits (polymarket, hobbs2, etc.) — only when the agent is writing to `/Users/jeffhobbs/Desktop/CrewSwarm/` itself.
- Reference: Ouroboros `review.py` + `control.py` for implementation pattern (github.com/joi-lab/ouroboros).

## [2026-02-25] QA + dispatch: ALWAYS discover project structure before auditing
- QA must run `@@RUN_CMD find /project -name "*.py"` first if paths are unknown — never assume flat structure
- Projects in this system use src/ subdirectories (e.g. src/backtest/engine.py, src/api/main.py)
- When QA says "file not found", the fix is to update the PROMPT not re-dispatch with hardcoded paths
- Fix root cause first (prompt/config), THEN re-dispatch — never override with a one-off dispatch patch

## [2026-02-25] crew-fixer: backtest engine bugs fixed in polymarket-ai-strat
- PROJECT: /Users/jeffhobbs/Desktop/polymarket-ai-strat/ (NOT llm-trading-api — that is a separate unrelated project)
- Fixed position sizing for shorts: multiply by position direction (+1/-1) so short positions get positive position_value
- Fixed stop-loss timing: calculate position_value BEFORE stop-loss check, track entry_price separately
- Fixed price_change scoping: calculate fresh each iteration inside loop, not carried from previous iteration
- main.py already passed position_size/stop_loss_pct to run_backtest; CORS already fixed to use env var instead of "*"
- Key files: src/backtest/engine.py, src/api/main.py, src/data/historical_data.py

## [2026-02-25] crew-lead dispatch: ALWAYS include project path and key files
- When dispatching to ANY agent (QA, fixer, coder), always include the full absolute project path, key files to read, and what to write
- "send to QA" with no context = vague task = agent asks for clarification = wasted cycle
- Minimum dispatch must include: project dir, specific files to check, output file path
- crew-lead updated its own prompt via @@PROMPT to enforce this — check agent-prompts.json → "crew-lead" key

## [2026-02-24] crew-coder-back: llm-trading-api project created
- Created FastAPI backend at /Users/jeffhobbs/Desktop/llm-trading-api/ with multi-provider LLM support
- Supports OpenAI, Anthropic, Groq, Mistral, Cerebras via environment-configured API keys
- API key auth via X-API-Key header, CORS configurable via env vars

## [2026-02-25] crew-lead: crew-lead: When dispatching to crew-qa, always include full project details (files, paths, features) in the task to avoid user meltdowns like this one.

## [2026-02-25] crew-lead: for project-specific tips.

## [2026-02-25] crew-lead: to build a collective memory (e.g., logging best practices for prompts).

## [2026-02-25] crew-mega: Polymarket specialist
- Always read ROADMAP.md first — tracks all and features priorities
- Backtest entry point: python3 -m src.api.main with --strategy flag
- Key metrics: Sharpe ratio (higher = better), max_drawdown (lower = better), total_return
- Strategy code lives in src/backtest/strategies/ — use existing patterns
- Parameter extraction: see src/ai/parameter_extractor.py

## [2026-02-25] crew-lead: crew-lead: fact to remember he is actually good at his job and is proactive for reading the ROAMAP and keeping the team on task - he is organized and can remember exactly where the project is - when asked about status he knows exactly what each member of the team is doing and their activity
