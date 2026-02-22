# Agent Registry

> Auto-updated by `scripts/sync-agents.mjs`. Do not edit the table manually.

Last updated: 2026-02-22

## Dispatch command

```bash
node ~/Desktop/CrewSwarm/gateway-bridge.mjs --send <agent-name> "<task>"
```

## Available agents

| Agent | Role | Best for |
|---|---|---|
| `crew-main` | 🦊 Coordination | Triage, fallback, multi-step dispatch |
| `crew-coder` | ⚡ Implementation | General code, files, shell commands |
| `crew-pm` | 📋 Planning | Break requirements into phased tasks |
| `crew-qa` | 🔬 QA | Read-only tests, audits, validation |
| `crew-fixer` | 🐛 Bug fixing | Debug failures, patch issues |
| `crew-security` | 🛡️ Security | Vulnerability audits, hardening |
| `crew-coder-front` | 🎨 Frontend | HTML, CSS, vanilla JS, design system |
| `crew-coder-back` | 🔧 Backend | APIs, databases, server-side logic |
| `crew-github` | 🐙 Git | Commits, PRs, branches, push |
| `crew-frontend` | 🖥️ Frontend alt | UI implementation |
| `crew-copywriter` | ✍️ Copywriting | Headlines, CTAs, product copy |
| `crew-telegram` | 💬 Telegram | Send messages via Telegram bridge |

## Notes

- `crew-qa` is READ-ONLY. It cannot write files. Findings go back to crew-fixer.
- `crew-github` runs git commands via @@RUN_CMD (git commands are whitelisted).
- `crew-main` and `crew-pm` are the only agents that can dispatch subtasks.
