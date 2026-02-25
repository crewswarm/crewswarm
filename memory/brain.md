# Brain — Project Knowledge

Agents: append discoveries here. This is the persistent knowledge base for this workspace.
Read it to avoid repeating mistakes. Write to it when you learn something durable.

## Format

```
## [YYYY-MM-DD] agent-name: one-line title
Key fact or decision. Max 3 sentences. Be specific — no fluff.
```

---

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

## [2026-02-25] QA + dispatch: ALWAYS discover project structure before auditing
- QA must run `@@RUN_CMD find /project -name "*.py"` first if paths are unknown — never assume flat structure
- Projects in this system use src/ subdirectories (e.g. src/backtest/engine.py, src/api/main.py)
- When QA says "file not found", the fix is to update the PROMPT not re-dispatch with hardcoded paths
- Fix root cause first (prompt/config), THEN re-dispatch — never override with a one-off dispatch patch

## [2026-02-25] crew-fixer: backtest engine bugs fixed
- Fixed position sizing for shorts: multiply by position direction (+1/-1) so short positions get positive position_value
- Fixed stop-loss timing: calculate position_value BEFORE stop-loss check, track entry_price separately
- Fixed price_change scoping: calculate fresh each iteration inside loop, not carried from previous iteration
- main.py already passed position_size/stop_loss_pct to run_backtest; CORS already fixed to use env var instead of "*"

## [2026-02-24] crew-coder-back: llm-trading-api project created
- Created FastAPI backend at /Users/jeffhobbs/Desktop/llm-trading-api/ with multi-provider LLM support
- Supports OpenAI, Anthropic, Groq, Mistral, Cerebras via environment-configured API keys
- API key auth via X-API-Key header, CORS configurable via env vars
