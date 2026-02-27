# PM-led task delegation (no broadcast race)

**Last Updated:** 2026-02-20

## How far we were / what was missing

- **Before:** Tasks were sent with `--broadcast`. All 7 agents received the same task; the first to grab the lease did the work. Others skipped. No real “PM assigns subtasks to coder vs QA vs fixer.”
- **Now:** We have **targeted send**: only the agent you name receives the task. Orchestrators can do “PM plan → send task 1 to crew-coder, task 2 to crew-qa” with no race.

## Code that does it

### 1. Gateway-bridge: `--send <agent> "<message>"`

Sends a task to **one** RT agent. Only that daemon processes it.

```bash
node gateway-bridge.mjs --send crew-coder "Create server.js with Express and GET /health"
node gateway-bridge.mjs --send crew-qa "Add tests for server.js"
node gateway-bridge.mjs --send crew-pm "Break down: Build a TODO API with CRUD and tests"
```

- Connects to OpenCrew RT only (no gateway WebSocket).
- Publishes to `command` with `to: agentId`.
- Waits for that agent’s reply on `done` (by taskId/correlationId).
- Prints the reply on stdout.

### 2. Natural PM orchestrator (targeted workers)

`natural-pm-orchestrator.mjs` now dispatches worker tasks with `--send`:

- Asks PM for a plan (still via `CREWSWARM_RT_AGENT=crew-pm` + gateway-bridge).
- Parses the plan into `(agent, task)` pairs (regex + fallback to single crew-coder task).
- For each pair runs: `node gateway-bridge.mjs --send <agent> "<task>"`.

So: **PM plans in natural language → orchestrator sends each subtask only to the assigned agent.**

### 3. Unified orchestrator (targeted workers)

`unified-orchestrator.mjs` uses the same idea:

- Step 1: PM natural-language plan (gateway-bridge with PM agent).
- Step 2: PM (or parser) converts plan to JSON.
- Step 3: For each task in the plan, `callAgent(agentId, task, false, true)` which runs gateway-bridge with `--send agentId task`.
- Step 4: Verification (e.g. file existence).

So both orchestrators now do **delegation**, not broadcast racing.

## Flow summary

| Step | Who | How |
|------|-----|-----|
| 1. Plan | crew-pm | Orchestrator runs gateway-bridge with `CREWSWARM_RT_AGENT=crew-pm` (or could use `--send crew-pm "plan: ..."`). |
| 2. Parse | Orchestrator | Regex on PM reply (natural-pm) or “parser” prompt → JSON (unified). |
| 3. Execute | crew-coder, crew-qa, etc. | `gateway-bridge.mjs --send <agent> "<task>"` so only that agent gets the task. |
| 4. Verify | Orchestrator | e.g. check files exist (unified). |

## What to run

- **Single task to one agent:**  
  `node gateway-bridge.mjs --send crew-coder "Your task here"`

- **Multi-step with PM plan + targeted workers:**  
  `node natural-pm-orchestrator.mjs "Build Express server with package.json, server.js, README, npm install, and verify"`  
  or  
  `node unified-orchestrator.mjs "Same requirement"`

- **Broadcast (everyone gets same task, first to claim does it):**  
  `node gateway-bridge.mjs --broadcast "Task"`

## Notes

- RT daemons must be running (`openswitchctl status`).
- OpenCode sandbox: tasks that create files must use paths inside the project (e.g. `test-output/` or repo paths), not `/tmp`, or permission may be denied.
- PM reply quality (and parsing) still limits how good the breakdown is; the **routing** is now correct (targeted send, no race).
