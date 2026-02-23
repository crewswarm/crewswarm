# Go Public Roadmap

This checklist tracks what must be true before CrewSwarm is considered public-launch ready. Order of work: **Smoke + CI first** (highest leverage), then doctor, observability, fresh-machine, runaway + protocol.

## PM prompts (done)

These are implemented in `pm-loop.mjs`:

- **Strict output template** for expanded tasks: `TARGET_AGENT`, `TASK`, `FILES`, `SUCCESS_CRITERIA` — parsed and used in the loop.
- **No optionality** in core execution: removed “if helpful” from expansion and self-extend user prompts.
- **Self-extend exactly 4 items**: parser uses `slice(0, 4)`; warning logged when model returns ≠4.

## Current gap snapshot

| Area | Distance | Main gaps |
|---|---|---|
| Smoke tests | Close | smoke-dispatch + E2E + PR CI (`.github/workflows/smoke.yml`) in place. |
| Doctor | Medium | No `openswitchctl doctor` for path/config/provider/token checks. |
| Runaway protection | Close | Add hard bridge cap, optional queue cap, and jittered retries. |
| Protocol + contracts | Medium | One canonical JSON dispatch/result schema and coordinator-only dispatch tests. |
| Observability | Medium | End-to-end correlation IDs, one health snapshot command, consistent structured logs. |
| Fresh-machine | Medium | Automate clean-user `clone -> install -> first build` proof and doc checklist. |
| Public-repo hygiene | Close | Keep secrets scrubbed, maintain top-failure troubleshooting section. |

## Phase 1 - Reliability gates (must-have)

### 1) Smoke + CI (highest leverage)

- [x] Add smoke-dispatch (coder + main).
- [x] Add one E2E build smoke.
- [x] Add npm scripts: `npm run smoke:dispatch`, `npm run smoke:e2e`, `npm run smoke`.
- [x] Wire both into PR CI and **fail hard on timeout / non-done** (`.github/workflows/smoke.yml`).

For green CI: add repo secrets `CREWSWARM_RT_TOKEN` and `GROQ_API_KEY`. Without the Groq key, smoke may timeout (no LLM).

Success criteria:
- Both dispatch paths succeed within configured timeout.
- E2E smoke exits non-zero on any failed check.

### 2) Add openswitchctl doctor

- [ ] Add `openswitchctl doctor` with clear PASS/FAIL output.
- [ ] Path/config/token/model/output-dir checks.
- [ ] Actionable fix messages for each failure.
- [ ] Non-zero exit on blockers.

Success criteria:
- New users can run `openswitchctl doctor` and fix all blockers without reading code.

### 3) Runaway + protocol hardening (see also §4)

**Runaway:**
- [ ] Bridge cap (hard max bridge process count).
- [ ] Queue limit + bounded retries + jitter.
- [x] Duplicate spawn guard per agent (already in `start-crew.mjs`).

**Protocol (detailed in §4):**
- [ ] One canonical JSON dispatch/result schema.
- [ ] Coordinator-only dispatch tests.

## Phase 2 - Operability and correctness

### 4) Protocol + contract enforcement

- [ ] One canonical JSON dispatch format.
- [ ] One result envelope shape (`status`, `taskId`, `result`, `error`, `filesTouched`).
- [ ] Coordinator-only dispatch tests (non-coordinator cannot dispatch).

### 5) Observability pass

- [ ] One correlation ID from PM -> dispatch -> done/issues -> synthesis.
- [ ] One `openswitchctl health` command with queue/agents/failures snapshot.
- [ ] Logs human-readable and machine-parseable where needed.

## Phase 3 - Public launch confidence

### 6) Fresh-machine automation

- [ ] Scripted clean-user install test.
- [ ] Documented “clone -> install -> first build” checklist with expected outputs.
- [ ] Failure recovery steps in docs.

### 7) Public-repo hygiene

- [ ] Keep only templates/examples for secrets (`.env.example`, config examples).
- [ ] Maintain `.gitignore` for logs/state/runtime artifacts.
- [ ] Keep top-5 troubleshooting section current as issues are discovered.

## Exit criteria for "9/10 ready"

- [ ] Smoke + E2E checks green on every PR.
- [ ] `openswitchctl doctor` catches all common setup errors.
- [ ] No runaway process incidents in a 24-hour soak test.
- [ ] Fresh-machine install succeeds from docs only.
- [ ] Demo flow (`crew-lead -> crew-coder`, `crew-lead -> crew-main`) passes 3/3 attempts.
