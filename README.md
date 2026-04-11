# crewswarm

**A multi-engine AI coding platform.** Switch between Claude Code, Cursor, Gemini, Codex, OpenCode, and crew-cli mid-conversation. Parallel agents. Persistent sessions. No vendor lock-in.

[![npm version](https://img.shields.io/npm/v/crewswarm)](https://www.npmjs.com/package/crewswarm)
[![Release Check](https://img.shields.io/badge/release_check-required-blue)](https://github.com/crewswarm/crewswarm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)
[![Website](https://img.shields.io/badge/website-crewswarm.ai-blue)](https://crewswarm.ai)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/crewswarm?label=Sponsor)](https://github.com/sponsors/crewswarm)

![crewswarm Demo](website/crewswarm-demo.gif)

---

## Why crewswarm?

**Rate limits are real.** Every $20/month AI coding plan has them. Claude, Cursor, Codex — you'll hit the wall mid-feature.

crewswarm lets you switch engines without throwing away your working context. Or pick the best CLI for each job:

| Engine | Best for | Key strength |
|---|---|---|
| **Claude Code** | Large refactors, frontend | Full workspace context, session resume |
| **Cursor CLI** | Architecture, complex reasoning | Parallel waves, isolated contexts |
| **Gemini CLI** | Research, SEO, free fallback | Free: 60 req/min, Google Search built in |
| **Codex CLI** | Backend, fast iteration | Full sandbox, no approval prompts |
| **OpenCode** | Provider flexibility | Any model (Groq/DeepSeek/Ollama) |
| **crew-cli** | Execution engine, any model | 40+ models, 16 providers, sandbox, parallel workers |

---

## crew-cli: the execution engine

crew-cli is the built-in execution engine. It runs standalone or as one of crewswarm's 6 engines. Unlike other AI coding CLIs that lock you to one provider, crew-cli works with any model:

| Provider | Models | Driver |
|---|---|---|
| **OpenAI** | GPT-5.4, GPT-5.2, GPT-4.1, o3-mini, o4-mini | OpenAI API |
| **Anthropic** | Claude Opus/Sonnet/Haiku (API + OAuth) | Anthropic API + CCH |
| **Google** | Gemini 2.5 Flash, Gemini 3 Pro | Gemini API |
| **xAI** | Grok 4.20, Grok 4-1, Grok 3, grok-code-fast | OpenAI-compatible |
| **DeepSeek** | DeepSeek Chat, DeepSeek Reasoner | OpenAI-compatible |
| **Groq** | Llama 4 Scout, Kimi K2, Qwen3-32B, GPT-OSS | OpenAI-compatible |
| **Fireworks** | DeepSeek v3, GLM-5, Kimi K2.5, GPT-OSS | OpenAI-compatible |
| **Mistral** | Mistral Large, Codestral, Devstral | OpenAI-compatible |
| **Cerebras** | Qwen 3-235B, Llama 3.1 | OpenAI-compatible |
| **NVIDIA** | Llama 3.3-70B | OpenAI-compatible |
| **OpenCode/Zen** | 39 models (GPT-5.x, Claude, Gemini, GLM, Kimi, MiniMax, Qwen, Nemotron) | OpenAI-compatible |
| **OpenRouter** | 100+ models | OpenAI-compatible |
| **Ollama** | Any local model | OpenAI-compatible |

Three API formats, one engine. Bring your own keys, use OAuth from Claude Code / Codex / Gemini CLI, or run free models via Groq / Ollama / OpenRouter.

### Benchmark: free models match Claude Opus

Single-model pipeline testing — same model handles routing, planning, execution, review, and fixing. All tests pass on 6 TypeScript coding tasks (bugfix, feature, refactor, multi-file).

| Model | Provider | Result | ~Cost/Task |
|---|---|---|---|
| Qwen 3.5 (397B) | Ollama cloud | **All tests pass** | FREE |
| GLM-5.1 | Ollama cloud | **All tests pass** | FREE |
| Claude Sonnet 4.6 | Anthropic OAuth | **All tests pass** | ~$0.06 |
| Claude Opus 4.6 | Anthropic OAuth | **All tests pass** | ~$0.07 |
| GPT-5.4 | OpenAI OAuth | **All tests pass** | ~$0.13 |

Two free local models (Qwen 3.5, GLM-5.1 via Ollama) pass every test that Claude Opus does. [Full results &rarr;](https://crewswarm.ai/benchmarks.html)

**What makes crew-cli different from other AI coding CLIs:**
- **Failure memory** — blocks repeated bad moves, forces new approaches
- **Verification-first** — won't declare success until proof is shown
- **Patch critic** — evaluates every edit for quality in real time
- **Parallel workers** — splits multi-file tasks into concurrent work units
- **Sandbox preview** — all changes staged before writing to disk
- **Smart delegation** — picks the right model tier for each subtask

---

## Quickstart

```bash
npm install -g crewswarm
crewswarm
```

That's the default path for most users. Dashboard opens at `localhost:4319`, Vibe IDE at `localhost:3333`.

### Contributor setup from source

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
bash install.sh
npm run doctor
npm run restart-all
```

Use source install when you want to work on crewswarm itself or debug local internals.

### Docker for servers and teams

```bash
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

Use Docker when you want stronger isolation, easier restarts, or a shared server/team box.

### What does it cost?

**$0.** crewswarm is free and open source (MIT). You bring your own API keys — or use CLI OAuth (Claude, Cursor, Gemini login once, no keys needed). Free options: Gemini CLI (1,000 req/day), Groq (free tier), Ollama (fully local).

---

## What makes it different

| Capability | crewswarm | Cursor | Windsurf | Devin | Copilot |
|---|---|---|---|---|---|
| Multi-engine (6 CLIs) | Yes | No | No | No | No |
| Native session resume | Yes | No | No | No | No |
| Parallel agent waves | Yes | No | No | Partial | No |
| Browser IDE + terminal | Vibe | Desktop | Desktop | Yes | Yes |
| 20+ specialist agents | Yes | 1 | 1 | 1 | 1 |
| PM Loop (autonomous roadmap) | Yes | No | No | Partial | No |
| Swarm Chat (@mention dispatch) | Yes | No | No | No | No |
| Local-first / no cloud | Yes | Partial | No | No | No |
| Open source | Yes | No | No | No | No |

---

## How it works

1. **You write a requirement** — one sentence, one paragraph, or a full spec
2. **crew-pm plans it** — breaks work into phases, assigns specialists
3. **Agents execute in parallel** — backend, frontend, and tests can run simultaneously
4. **Done. Files on disk.** — real files, real tests, real output

```
Dashboard / Vibe IDE / crew-cli / crewchat / Telegram / WhatsApp / OpenClaw / MCP
                    |
                crew-lead (router)
                    |
                 RT Bus
                    |
     ─────────────────────────────────
     |        |        |       |       |
   crew-pm  coder     qa    fixer   github
                    |
        Code Engines: Claude · Cursor · Gemini · Codex · OpenCode · crew-cli
                    |
            real files, commands, memory
```

---

## Surfaces

- **Dashboard** — web control plane at `localhost:4319` (agents, engines, models, build, sessions)
- **Vibe IDE** — browser-based editor + terminal + chat at `localhost:3333`
- **crew-cli** — execution engine: 40+ models, 16 providers, 41 built-in tools
- **crewchat** — conversational interface for quick tasks
- **Telegram** — chat with your crew from your phone
- **WhatsApp** — mobile messaging bridge
- **OpenClaw plugin** — use crewswarm as the engineering backend for OpenClaw desktop apps (`npm i crewswarm-openclaw-plugin`)
- **MCP server** — plug crewswarm into any MCP-compatible editor

---

## Per-agent model configuration

Every agent gets its own model. Use cheap models for routing, expensive for coding:

```json
{
  "agents": [
    { "id": "crew-lead", "model": "groq/llama-3.3-70b-versatile" },
    { "id": "crew-pm", "model": "google/gemini-2.5-flash" },
    { "id": "crew-coder", "model": "anthropic/claude-sonnet-4-20250514" },
    { "id": "crew-qa", "model": "google/gemini-2.5-flash" },
    { "id": "crew-fixer", "model": "openai/codex-mini-latest" }
  ]
}
```

Or skip API keys entirely — use Claude Code, Cursor, or Gemini CLI with OAuth login.

---

## The crew

| Agent | Role |
|---|---|
| `crew-lead` | Routes tasks, manages conversation |
| `crew-pm` | Plans, breaks down, prioritizes |
| `crew-coder` | Writes code (full-stack) |
| `crew-coder-back` | Backend specialist |
| `crew-coder-front` | Frontend specialist |
| `crew-qa` | Tests and validates |
| `crew-fixer` | Debugs and repairs |
| `crew-security` | Security review |
| `crew-github` | Git, PRs, branches |
| `crew-architect` | System design |
| `crew-orchestrator` | Wave dispatch |
| `crew-copywriter` | Docs and content |
| `crew-frontend` | UI/UX polish |
| `crew-main` | General coordination |

---

## Built with crewswarm

- **VS Code extension** — full extension from prompt to package in 10 minutes
- **crewswarm.ai** — the production website you see, 90% built by the swarm in 30 minutes
- **Session resume** — native resume across 6 CLI engines, built in one session

---

## Commands

```bash
crewswarm                    # Start full stack: RT bus, crew-lead, bridges, then dashboard
crewswarm pm-loop            # Run autonomous PM loop
npm run doctor               # Preflight check
npm run restart-all          # Restart the stack
npm test                     # Run the core test suites
npm run test:report          # View test results summary
crew exec "Build X"          # Send task via CLI
```

---

## Deployment

```bash
# Most users
npm install -g crewswarm
crewswarm

# Servers / teams
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

See [deploy.html](https://crewswarm.ai/deploy.html) for Docker, cloud VM, and production setup.

---

## Documentation

- [Website](https://crewswarm.ai)
- [Vibe IDE](https://crewswarm.ai/vibe.html)
- [crew-cli](https://crewswarm.ai/cli.html)
- [Models & Providers](https://crewswarm.ai/models.html)
- [Security](https://crewswarm.ai/security.html)
- [API Docs](https://crewswarm.ai/api.html)
- [@@Protocol](https://crewswarm.ai/atat.html)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Issues and PRs welcome.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

MIT
