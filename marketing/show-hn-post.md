# Show HN Post

## How to submit on news.ycombinator.com/submit

- **Title:** `Show HN: crewswarm – hit a rate limit, switch engines, keep your context`
- **URL:** `https://crewswarm.ai/`
- **Text:** *(leave blank — the URL is the post, first comment is the explanation)*

Immediately after submitting, post this as the first comment:

---

## First Comment (copy-paste this immediately after the post goes live)

Hit your Claude daily limit mid-refactor again? Switched to Codex, re-explained everything, lost context? Went to Gemini CLI, hit their quota too?

Every AI coding tool locks you into one provider. Claude Code is Anthropic-only. Codex is OpenAI-only. Gemini CLI is Google-only. You can't switch without starting over. That's the problem crewswarm solves.

Open source, local-first, MIT.

**The platform:**

The mental model: you're the PM, agents are your engineers. You describe what needs to happen. The system plans it, dispatches to specialist agents, runs them in parallel, verifies output.

- **crew-lead** routes your task: quick answer, single agent, or parallel execution
- **Wave orchestrator** splits complex work across specialists running simultaneously in isolated git worktrees — backend, frontend, QA, security all moving at once
- **20+ specialist agents** with their own system prompts, models, and tools. Shared persistent memory per project, fresh context windows
- **6 coding engines** — Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, crew-cli. Rate limited? Next task goes to a different engine. Sessions resume across all of them
- **PM Loop** — reads your ROADMAP.md, dispatches tasks, marks done/failed, keeps going. Has shipped features overnight
- **8 surfaces** — Vibe (browser IDE with Monaco, terminal, live file sync), Dashboard (control plane), crew-cli, crewchat, Telegram, WhatsApp, OpenClaw plugin, MCP server (64 tools). Same crew, same memory, any interface

**crew-cli — the execution engine:**

Grok has no coding CLI. DeepSeek has no CLI. Qwen, Kimi, Groq, MiniMax, Ollama — nothing. crew-cli gives every model a full agentic coding environment:

- 45+ built-in tools: file I/O, git operations, LSP diagnostics, shell, web search, Docker sandbox, memory, sub-agent spawning, git worktree isolation
- 3-tier pipeline: cheap router → expensive planner (only when needed) → tool-using workers
- Execution quality engine: 8 deterministic modules — failure memory (blocks repeated mistakes), verification gates (no "done" without proof), patch critic (catches unread edits and scope creep), action ranking, task-mode strategies, adaptive weights, structured history, smart delegation. No extra LLM calls

29 models score 100/100 on our coding benchmark. Groq GPT-OSS 20B ($0.0003/task) outputs the same verified TypeScript as Claude Opus ($0.03/task) — 100x cheaper, same quality. The engine prevents the failure modes that make cheap models worse — skipping verification, hallucinating edits, looping. Attach Ollama to your security agent, Groq to your PM, Claude only where it matters.

**Economics:** L1 router $0.075/M → L2 planner $2-3/M (only when needed) → L3 workers $0.0003-0.03/task. Typical feature: $0.02-0.08.

Tested with 40+ models across 12+ providers — works with any OpenAI-compatible endpoint. 45+ tools, ~64K LOC TypeScript.

`npm i -g crewswarm && crewswarm` (full platform) or `npm i -g crewswarm-cli && crew doctor` (CLI only)

Repo: https://github.com/crewswarm/crewswarm
Site: https://crewswarm.ai/
Vibe: https://crewswarm.ai/vibe.html
