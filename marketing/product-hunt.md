# Product Hunt Launch

## Product Name
crewswarm

## Tagline (60 chars max)
Multi-agent AI coding — you're the PM, agents are engineers

## Description

crewswarm is an open-source, local-first platform that gives you an AI engineering crew instead of a single assistant. Stinki (crew-lead) is the shit-talking crew leader who routes your work, picks the right agents, and won't let anyone declare "done" without proof.

You describe the work once. Stinki routes it to 20+ specialist agents (coder, QA, fixer, security, PM, copywriter), runs them in parallel in isolated git worktrees, picks the right model from 40+ options across 12 providers, and verifies the output before declaring done.

6 coding engines (Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, crew-cli) — hit a rate limit, the next task routes to a different engine automatically. Session state resumes across all of them.

crew-cli is the missing CLI for every model that doesn't have one. Grok, DeepSeek, Qwen, Groq, Ollama — none of them have agentic coding tools. crew-cli gives any model 45+ tools and an execution quality engine that makes $0.0003/task models produce the same verified code as $0.03/task ones.

8 surfaces: Vibe (browser IDE), Dashboard, crew-cli, crewchat, Telegram, WhatsApp, OpenClaw plugin, MCP server.

MIT license. Local-first. No cloud dependency. Your code never leaves your machine.

## Topics
- Developer Tools
- Open Source
- Artificial Intelligence
- Productivity

## Links
- Website: https://crewswarm.ai
- GitHub: https://github.com/crewswarm/crewswarm
- Twitter: https://twitter.com/crewswarm

## Maker Comment

Hit your Claude limit mid-refactor? Switched to Codex, re-explained everything, lost context? Every AI coding tool locks you into one provider. You can't switch without starting over.

crewswarm sits between you and the tools. Stinki (crew-lead) is the foul-mouthed crew leader who plans your work, dispatches to 20+ specialist agents, runs them in parallel in git worktrees, and won't accept "done" without evidence.

The part that doesn't exist elsewhere: crew-cli gives agentic coding to every model that doesn't have its own CLI — Grok, DeepSeek, Qwen, Groq, Ollama. The execution quality engine (8 deterministic modules) makes cheap models match expensive ones. 29 models at 100/100 on our coding benchmark. Groq GPT-OSS 20B ($0.0003/task) = same quality as Claude Opus ($0.03/task). 100x cheaper.

PM Loop: point Stinki at your ROADMAP.md and walk away. He ships features overnight. No complaints. Some profanity.

Local-first, MIT, ~64K LOC TypeScript.

`npm i -g crewswarm && crewswarm`

## Media Needed
- [ ] Logo (website/favicon.webp or higher-res version)
- [ ] Screenshot: Vibe IDE showing agent chat + file sync
- [ ] Screenshot: Dashboard showing agent lanes + model assignments
- [ ] Screenshot: crew-cli REPL with benchmark output
- [ ] Demo video (~2 min): complex feature request → PM loop → parallel agents → shipped code
