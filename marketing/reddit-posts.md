# Reddit Launch Posts

Stagger 1-2 hours after HN post. Each subreddit gets a different angle. Be genuine, not promotional.

---

## r/LocalLLaMA

**Title:** I built an open-source execution engine that makes Llama 3.3 70B produce the same verified code as Claude Opus — here's how

**Body:**

I've been building crewswarm, a multi-agent AI coding platform. The part that might interest this community: our execution quality engine makes local and cheap models match premium ones on coding tasks.

**The problem:** AI coding agents built on top of Llama, Qwen, DeepSeek, etc. fail in predictable ways — they retry the same broken command, declare "done" without running tests, edit files they never read, waste turns exploring instead of acting. These aren't model problems. They happen with GPT-5 and Claude too. But cheap models hit them more often because they have less built-in self-correction.

**The fix:** 8 deterministic quality modules that wrap every task:
- Failure memory blocks repeated mistakes
- Verification gate demands proof before "done"
- Patch critic catches unread edits and scope creep
- Action ranking steers toward highest-value next action
- No extra LLM calls — all rule-based

**Result:** 29 models score 100/100 on our coding benchmark. Groq GPT-OSS 20B ($0.0003/task) produces identical verified TypeScript to Claude Opus ($0.03/task) — 100x cheaper.

crew-cli also gives agentic coding to models that don't have their own CLI — attach any Ollama model and it gets 45+ tools (file I/O, git, LSP, shell, web search, Docker sandbox). The 3-tier pipeline uses a cheap model for routing, expensive model only for planning, and your local model for execution.

The full platform also has 20+ specialist agents, 6 coding engines (Claude Code, Codex, Gemini, Cursor, OpenCode, crew-cli), parallel execution in git worktrees, and a PM loop that reads ROADMAP.md and ships autonomously.

MIT license, local-first, TypeScript.

- Site: https://crewswarm.ai
- Repo: https://github.com/crewswarm/crewswarm
- CLI benchmarks: https://crewswarm.ai/cli.html

Happy to share details on the engine internals or benchmark methodology.

---

## r/OpenAI

**Title:** We built a platform that uses GPT-5.4 for planning and cheaper models for execution — 29 models at 100/100 quality

**Body:**

I built crewswarm because I was tired of paying premium pricing for every single step of an AI coding task. Not every step needs GPT-5.4's reasoning.

The 3-tier pipeline:
- **L1 router** — cheap model classifies the task ($0.0001)
- **L2 planner** — GPT-5.4 or Claude decomposes complex tasks ($0.003-0.02/plan)
- **L3 workers** — any model executes with our quality engine ($0.0003-0.03/task)

The execution quality engine (8 modules: failure memory, verification gates, patch critic, etc.) makes cheap models produce identical quality to premium ones. 29 models score 100/100 on our coding benchmark.

Best part: Codex CLI only works with OpenAI models. crew-cli works with 40+ models across 12 providers. GPT-5.4 for planning, DeepSeek for cheap execution, Groq for fast routing. Or use OAuth — GPT-5.4 through Codex OAuth costs $0.

The broader platform: 20+ specialist agents, 6 coding engines running in parallel, session resume across all of them, PM loop for autonomous task execution.

Open source (MIT), local-first: https://github.com/crewswarm/crewswarm

---

## r/webdev

**Title:** Open-source AI coding platform with a browser IDE, 20+ specialist agents, and parallel execution — built with TypeScript

**Body:**

I've been building crewswarm — a multi-agent AI coding platform. Thought r/webdev might find the technical approach interesting.

**The idea:** Instead of one AI chat window, you get a full engineering crew. You're the PM. Specialist agents (crew-coder, crew-qa, crew-fixer, crew-security, crew-pm) handle the work in parallel, each with their own model and tools.

**Vibe IDE** is our browser workspace — Monaco editor, integrated terminal, multi-engine chat, and live file sync. When an agent edits a file, you see it update in the editor within 500ms. No Electron, runs at localhost:3333. Think Cursor but you pick any model from any provider.

**The wave orchestrator** runs agents in parallel git worktrees. crew-coder-back builds the API while crew-coder-front wires the UI while crew-qa writes tests — simultaneously, isolated, then merged back.

**crew-cli** is the execution engine — gives agentic coding to every model. 45+ built-in tools including LSP diagnostics, git operations, web search, Docker sandbox. An execution quality engine (8 modules) makes cheap models produce the same verified code as expensive ones. 29 models at 100/100 on our benchmark.

The whole thing is ~64K lines of TypeScript, MIT licensed, local-first.

Stack: Node.js, TypeScript, Monaco, WebSocket bus (ATAT protocol — 85% fewer tokens than JSON-RPC), 227 REST API endpoints.

- Demo: https://crewswarm.ai
- Repo: https://github.com/crewswarm/crewswarm
- Vibe: https://crewswarm.ai/vibe.html

---

## r/macapps (shorter, focused)

**Title:** crewswarm — native macOS chat app for multi-agent AI coding (open source)

**Body:**

Built crewchat — a native macOS chat surface for crewswarm, our multi-agent AI coding platform.

Talk to 20+ specialist AI agents from a lightweight native app. Dispatch tasks, check status, route work to the right specialist. Connected to the same real-time bus as the browser IDE, dashboard, and CLI.

The full platform: 6 coding engines (Claude Code, Cursor, Codex, Gemini, OpenCode, crew-cli), parallel agent execution, session resume, and a PM loop that reads your roadmap and ships autonomously.

Free, open source (MIT), local-first.

https://crewswarm.ai
https://github.com/crewswarm/crewswarm
