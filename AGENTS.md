# CrewSwarm — AI Agent Memory

> Persistent facts and preferences for Cursor AI sessions. Updated by the continual-learning skill.

---

## Learned User Preferences

- User prefers no follow-up questions when intent is clear — just act
- User prefers concise replies with no filler phrases or preamble
- User accesses crew-lead via the dashboard chat, the floating crew-chat.html window, and Telegram — all three must be kept in sync for any chat feature changes
- SwiftBar plugin is deployed by copying directly to `~/Library/Application Support/SwiftBar/Plugins/` — symlinks do not work with SwiftBar
- When opening Chrome via SwiftBar, always use the Chrome binary directly (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --app=URL --new-window`) — never use `open -a "Google Chrome" --args ...` because Chrome ignores `--args` when already running
- User wants "build me / build a / create a" to immediately trigger `@@PROJECT` and generate a roadmap — no clarifying questions, no feature lists first

---

## Learned Workspace Facts

- **Workspace root**: `/Users/jeffhobbs/Desktop/CrewSwarm`
- **Dashboard**: `scripts/dashboard.mjs`, serves on port 4319
- **crew-lead**: `crew-lead.mjs`, HTTP server on port 5010, manages chat history and project launches
- **PM loop**: `pm-loop.mjs` at workspace root, reads `ROADMAP.md`, dispatches tasks to agents
- **RT bus**: WebSocket on `ws://127.0.0.1:18889` — custom service, not OpenClaw
- **Telegram bridge**: `telegram-bridge.mjs`
- **SwiftBar source**: `contrib/swiftbar/openswitch.10s.sh` — always sync changes to both source and deployed copy
- **Agent prompts**: `~/.openclaw/agent-prompts.json` — configures system prompt per agent
- **Chat history**: stored as JSONL at `~/.crewswarm/chat-history/<sessionId>.jsonl`
- **Project registry**: stored at `~/.openclaw/orchestrator-logs/projects.json`

### CRITICAL — Dashboard JS Escape Bug (recurring)

**Problem**: `scripts/dashboard.mjs` serves its entire frontend as a string inside a Node.js server-side template literal. Any client-side JavaScript that uses template literals (`${...}`), apostrophes in single-quoted strings, or backticks inside the served HTML will be evaluated or broken by the outer server-side template literal.

**Symptoms**: `Uncaught SyntaxError: Invalid or unexpected token` at a line number in `(index)` — the rendered HTML. The line number in the error refers to the *served page*, not the source file.

**Root causes seen so far**:
1. Client-side `${variable}` inside a server-side template literal → server evaluates it, breaks JS
2. Apostrophe in a single-quoted JS string: `'Let's work...'` → breaks string parsing
3. Any backtick in inline client JS → terminates the server-side template literal early

**Fix pattern**:
- For client-side template literals: convert to string concatenation (`"Hello " + name` instead of `` `Hello ${name}` ``)
- For apostrophes: use double-quoted strings (`"Let's work"` not `'Let\'s work'`)
- For new client-side functions added to dashboard.mjs: always audit for backticks and `${...}` before saving
- Prefer pulling large client-side JS blocks out into separate `.js` files served as static assets — this eliminates the escaping problem entirely

**Prevention**: Before adding any client-side JavaScript inside `dashboard.mjs`, search for backticks and `${` in the new code. If found, rewrite to avoid them.

### Agent Allowlist

- RT daemon requires agents to be in `OPENCLAW_ALLOWED_AGENTS` env var — `crew-lead` and `crew-telegram` must be included
- Gateway-bridge processes are the actual agent workers — each agent runs as a separate `gateway-bridge.mjs` process

### Project Launch Flow

- `@@PROJECT` in crew-lead's reply → `draftProject()` calls PM LLM (Perplexity Sonar Pro or Groq) to generate a real roadmap
- Roadmap shown to user as an editable card — user approves before PM loop starts
- On confirm: `confirmProject()` creates project via dashboard API, writes `ROADMAP.md`, starts PM loop immediately
- PM loop uses LLM-based agent routing (with keyword-regex fallback) to send each task to the right specialist
