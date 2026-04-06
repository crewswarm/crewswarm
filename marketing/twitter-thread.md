# Twitter/X Launch Thread

Post from @crewswarm. Thread format — post tweet 1, then reply chain.

---

**Tweet 1 (hook):**

hit your Claude daily limit mid-refactor? switched to Codex, re-explained everything, lost context?

built crewswarm to fix this. multi-agent AI coding platform — 6 engines, 20+ specialist agents, parallel execution. switch engines without losing state.

open source. here's how it works 🧵

---

**Tweet 2 (the problem):**

every AI coding tool locks you into one provider.

Claude Code = Anthropic only
Codex CLI = OpenAI only
Gemini CLI = Google only

hit a rate limit? start over in a new tool. copy-paste your context. explain everything again.

multiple times a day.

---

**Tweet 3 (the solution):**

crewswarm sits between you and these tools. Stinki (crew-lead) is your co-founder who talks shit but gets the job done.

you describe the work once. Stinki:
- routes it to the right specialist agent
- picks the right engine (Claude, Codex, Gemini, Cursor, OpenCode, or crew-cli)
- runs agents in parallel in isolated git worktrees
- verifies the output before declaring done

---

**Tweet 4 (crew-cli):**

Grok has no CLI. DeepSeek has no CLI. Qwen, Kimi, Groq — none of them have agentic coding tools.

crew-cli is the missing CLI for every model that doesn't have one. 45+ tools, 3-tier pipeline, and an execution quality engine that makes $0.0003/task models produce the same verified code as $0.03/task ones.

---

**Tweet 5 (the engine — the proof):**

29 models score 100/100 on our coding benchmark.

Groq GPT-OSS 20B ($0.0003/task) = same quality as Claude Opus ($0.03/task). 100x cheaper.

The engine prevents the failure modes that make cheap models seem worse: no repeated mistakes, no "done" without proof, no unread edits. 8 modules, all deterministic.

---

**Tweet 6 (surfaces):**

Work from anywhere:

- Vibe — browser IDE (Monaco + terminal + live file sync)
- Dashboard — control plane
- crew-cli — terminal
- crewchat — native chat
- Telegram & WhatsApp — from your phone
- OpenClaw plugin
- MCP server (64 tools)

Same crew, same memory, any surface.

---

**Tweet 7 (PM loop):**

the PM Loop: point Stinki at a ROADMAP.md and walk away.

he reads the next task, dispatches to the right agents, roasts them if they fail, moves on.

has shipped features overnight while we slept. no complaints. some profanity.

---

**Tweet 8 (CTA):**

open source (MIT). local-first. no cloud.

npm i -g crewswarm && crewswarm

https://crewswarm.ai
https://github.com/crewswarm/crewswarm

---

## Alt: Single tweet version (for retweets/quotes)

open-sourced crewswarm — multi-agent AI coding platform.

you're the PM. Stinki (crew-lead) is your shit-talking co-founder who runs 20+ specialist agents across 6 coding engines.

hit a rate limit? he switches engines and keeps going. no context lost.

https://crewswarm.ai
