# crew-cli Permissions Model

This is the canonical explanation of what `crew-cli` can do in each mode and how approvals work.

## Core rule

`crew-cli` is local-first, but writes should remain inspectable and reversible whenever possible.

The main safety mechanism is the sandbox:

- edits accumulate in `.crew/sandbox.json`
- `/preview` shows pending changes
- `/apply` writes them to disk
- `/rollback` discards them

## Permission matrix

| Surface | Read files | Stage edits in sandbox | Write to disk | Shell/PTY | Network/model calls | Approval behavior |
|---|---|---|---|---|---|---|
| `crew chat` standalone | Yes | Yes | Via `/apply` or auto-apply | Limited through runtime/tool path | Yes | Depends on REPL mode / flags |
| `crew run` / `crew dispatch` / `crew plan` | Yes | Yes | Via apply path or explicit auto-approve settings | Yes, if task/tools require it | Yes | Depends on flags and execution policy |
| REPL `manual` | Yes | Yes | No implicit auto-apply | Available | Yes | No execution confirmation |
| REPL `assist` | Yes | Yes | No implicit auto-apply | Available | Yes | Confirmation before non-chat execution |
| REPL `autopilot` | Yes | Yes | Auto-apply may occur | Available | Yes | Minimal confirmation, automation-first |
| Connected mode via gateway | Usually via gateway/tool path | Yes or gateway-managed | Depends on gateway/agent path | Depends on engine path | Yes | Split between CLI and gateway runtime |
| Agent-assigned execution inside CrewSwarm | Yes | Depends on agent tool policy | Depends on engine/runtime path | Depends on agent/engine | Yes | Controlled by assigned engine + swarm policy |

## Practical guidance

- Start in `assist`
- use `/preview` before `/apply`
- use `/info`, `/tools`, and `/models-config` to inspect runtime state
- use explicit `--model` or `--engine` when reproducibility matters

## Related docs

- [INSTRUCTION-STACK.md](./INSTRUCTION-STACK.md)
- [SECURITY.md](./SECURITY.md)
- [REPL-MODES-AND-RELIABILITY.md](./REPL-MODES-AND-RELIABILITY.md)
