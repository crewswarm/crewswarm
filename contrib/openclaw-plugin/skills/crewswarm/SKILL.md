# CrewSwarm Dispatch Skill

## When to use this skill

Use CrewSwarm tools when the user asks you to **build, write, test, review, fix, or ship something** that would benefit from a specialist agent — especially multi-step work that crosses disciplines (code + tests + docs, or frontend + backend + QA).

**Trigger phrases:**
- "build / write / create / implement [feature]"
- "test / audit / review [code or PR]"
- "fix [bug]"
- "write docs / a README / a spec for..."
- "dispatch crew-coder / crew-qa / crew-pm to..."
- "have the crew handle..."

## Available tools

- `crewswarm_agents` — list all available agents (call this first if unsure)
- `crewswarm_dispatch` — send a task to a specialist and wait for the result
- `crewswarm_status` — poll a running task by taskId

## How to use

### Step 1 — pick the right agent

| Task type | Agent |
|---|---|
| Write or edit code (general) | `crew-coder` |
| Frontend / UI / CSS | `crew-coder-front` or `crew-frontend` |
| Backend / API / DB | `crew-coder-back` |
| Write tests, audit, QA | `crew-qa` |
| Fix a bug or error | `crew-fixer` |
| Plan a feature or roadmap | `crew-pm` |
| Security review | `crew-security` |
| Write docs, copy, README | `crew-copywriter` |
| Git / PR operations | `crew-github` |
| General / orchestration | `crew-main` |

If you're unsure, call `crewswarm_agents` first to see the live list.

### Step 2 — dispatch with a clear task

Write the task as a precise, self-contained instruction. Include:
- **What** to produce (file path, function name, endpoint, etc.)
- **How** to verify it worked (optional `verify` field)
- **Done condition** (optional `done` field)

Good example:
```
agent: "crew-coder"
task: "Write /src/api/auth.ts — a JWT login endpoint using jose. Accept email+password, validate against users array, return httpOnly cookie."
verify: "curl -X POST http://localhost:3000/login returns Set-Cookie header"
done: "File exists and contains createSigner from jose"
```

### Step 3 — wait and relay

`crewswarm_dispatch` blocks until the agent finishes (up to 5 minutes). The result includes the agent's full output including any files written, commands run, and verification results. Relay the relevant parts to the user.

## Chaining agents

For complex work, dispatch sequentially — use the result of one agent as context for the next:

```
1. crewswarm_dispatch crew-pm  → "Create a task plan for user auth feature"
2. crewswarm_dispatch crew-coder → "Implement: [result from step 1]"
3. crewswarm_dispatch crew-qa  → "Test: [result from step 2]"
```

## Slash command alternative

Users can also dispatch directly from any channel:
```
/crewswarm crew-coder write /tmp/hello.js — a 10-line express hello world
/crewswarm crew-qa audit the last PR
/crewswarm              ← lists available agents
```

## When NOT to use CrewSwarm

- Simple one-liner answers or explanations — handle directly
- Tasks you can complete yourself without writing files or running code
- If CrewSwarm is not running (`crewswarm_agents` returns empty or errors)
