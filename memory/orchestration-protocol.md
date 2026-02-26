# Orchestration Protocol

This document describes how agents coordinate work in CrewSwarm.

## Dispatch a Task to an Agent

```bash
node ~/Desktop/CrewSwarm/gateway-bridge.mjs --send <agent-name> "<task>"
```

Or via crew-lead chat (port 5010):
```
POST http://localhost:5010/chat
{"message": "have crew-coder <task description>"}
```

## Available Agents

<!-- AGENT_TABLE_START -->
| Agent | Role | Best for |
|-------|------|----------|
| `crew-main` | 🦊 Coordination | Chat, triage, fallback, dispatch |
| `crew-coder` | ⚡ Implementation | General code, files, shell commands |
| `crew-pm` | 📋 Planning | Break requirements into phased tasks |
| `crew-qa` | 🔬 Quality assurance | Tests, validation, audits |
| `crew-fixer` | 🐛 Bug fixing | Debug failures, patch QA issues |
| `crew-security` | 🛡️ Security review | Vulnerability audits, hardening |
| `crew-coder-front` | 🎨 Frontend specialist | HTML, CSS, JS, UI, design system |
| `crew-coder-back` | 🔧 Backend specialist | APIs, DBs, server-side logic |
| `crew-github` | 🐙 Git operations | Commits, PRs, branches, push |
| `crew-frontend` | 🖥️ Frontend (alt) | UI implementation |
| `crew-copywriter` | ✍️ Copywriting | Headlines, CTAs, product copy |
| `crew-telegram` | 💬 Telegram | Send messages via Telegram bridge |
| `crew-lead` | 🧠 Crew Lead | Top-level coordinator, user-facing chat |
| `crew-orchestrator` | 🎯 Orchestrator | Internal pipeline routing |
| `crew-seo` | 📈 SEO specialist | Metadata, keywords, site structure |
| `crew-ml` | 🧮 Machine learning | Models, data pipelines, training |
| `crew-mega` | 🔥 Polymarket strategy | Prediction market AI, backtesting |
| `crew-researcher` | 🔍 Research | Web search, fact-finding, reports |
| `crew-architect` | 🏗️ Architecture | System design, ADRs, tech decisions |
<!-- AGENT_TABLE_END -->

## Agent Tool Permissions

Each agent only has access to specific tools. If a tool is blocked (⛔), the agent
cannot execute it regardless of what the task asks.

| Agent | write_file | read_file | run_cmd | git | dispatch | telegram |
|---|---|---|---|---|---|---|
| crew-coder, coder-front, coder-back, frontend, fixer | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| crew-github | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| crew-qa, crew-security | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| crew-pm | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| crew-main | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| crew-copywriter | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| crew-telegram | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |

## Broadcast to All Agents

```bash
node ~/Desktop/CrewSwarm/gateway-bridge.mjs --broadcast "<message>"
```

## Coordinator Agents (PM loop / RT dispatch)

Only `crew-main` and `crew-pm` can auto-dispatch subtasks.
Use this format — on its own line in your reply:
```
@@DISPATCH:crew-coder|<one-line task description>
```
Note: `crew-lead` (the HTTP chat interface) uses a different JSON format internally —
do not use that format from gateway-bridge agents.

## Rules

1. One task per agent at a time (lease system prevents double-processing).
2. Agents reply with `task.done` when complete.
3. All tool executions are logged in the reply under `**Tool execution results:**`.
4. `crew-qa` should always @@READ_FILE before auditing — never assume file content.
