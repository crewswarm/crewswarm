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

- [x] Add `openswitchctl doctor` with clear PASS/FAIL output.
- [x] Path/config/token/model/output-dir checks.
- [x] Actionable fix messages for each failure.
- [x] Non-zero exit on blockers.

Success criteria:
- New users can run `openswitchctl doctor` and fix all blockers without reading code.

### 3) Runaway + protocol hardening (see also §4)

**Runaway:**
- [x] Bridge cap — `CREWSWARM_MAX_BRIDGES` in `scripts/start-crew.mjs` (default 20).
- [x] Queue limit + bounded retries + jitter — `CREWSWARM_DISPATCH_QUEUE_LIMIT` (default 50), jittered wave retry (500–1500ms).
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

- [x] Correlation ID — generated per-dispatch in `wave-dispatcher.mjs`, threaded through RT payload, pendingDispatches, SSE, and lifecycle events.
- [x] `openswitchctl health` — live snapshot: RT bus, bridges, crew-lead queue/pipelines, timeouts.
- [x] Logs human-readable and machine-parseable — `lib/runtime/logger.mjs` (`LOG_FORMAT=json` for NDJSON, default for human text).

## Phase 3 - Public launch confidence

### 6) Fresh-machine automation

- [x] Scripted clean-user install test (`scripts/fresh-machine-smoke.sh`).
- [x] Documented “clone -> install -> first build” checklist with expected outputs (`docs/FRESH-MACHINE-VERIFY.md`).
- [x] Failure recovery steps in docs (`docs/TROUBLESHOOTING.md`, `docs/FRESH-MACHINE-VERIFY.md`).

### 7) Public-repo hygiene

- [x] Keep only templates/examples for secrets (`.env.example` covers all 39+ env vars).
- [x] Maintain `.gitignore` for logs/state/runtime artifacts.
- [x] Keep top-5 troubleshooting section current — "Top 5 most common issues" table added to `docs/TROUBLESHOOTING.md`.

## Exit criteria for "9/10 ready"

- [ ] Smoke + E2E checks green on every PR (add `CREWSWARM_RT_TOKEN` + `GROQ_API_KEY` as GitHub repo secrets).
- [x] `openswitchctl doctor` catches all common setup errors.
- [ ] No runaway process incidents in a 24-hour soak test.
- [ ] Fresh-machine install succeeds from docs only.
- [ ] Demo flow (`crew-lead -> crew-coder`, `crew-lead -> crew-main`) passes 3/3 attempts.

---

## Phase 4 — Go public

Runs after all exit criteria above are green.

### 8) Version + release prep

- [ ] Bump `package.json` from `0.1.0-alpha` → `0.9.0-beta`.
- [ ] Write `CHANGELOG.md` entry for `[0.9.0-beta]` summarising Phases 1–3.
- [ ] Verify `name`, `description`, `author`, `license`, `repository` fields are public-ready.
- [ ] Run `npm pack --dry-run` — confirm no secrets or personal files included.
- [ ] Tag release commit: `git tag v0.9.0-beta && git push origin v0.9.0-beta`.

### 9) GitHub release

- [ ] Create GitHub release from tag; paste CHANGELOG entry as body.
- [ ] Attach `npm pack` tarball as release asset.
- [ ] Confirm `.github/ISSUE_TEMPLATE/` and `CONTRIBUTING.md` present (already done ✓).
- [ ] Set GitHub repo description (one-liner) and website URL.
- [ ] Add topics: `ai`, `multi-agent`, `llm`, `orchestration`, `autonomous-agents`.

### 10) README polish

- [ ] Add "Quick start" (3 commands: clone, install, start).
- [ ] Add screenshot or GIF of dashboard.
- [ ] Add CI status, version, and license badges.
- [ ] Verify no private URLs, personal names, or leaked project references remain.

### 11) Community

- [ ] Post announcement (HN / X / LinkedIn) linking to GitHub release.
- [ ] Optional: enable GitHub Discussions for community support.

### Phase 4 exit criteria

- [ ] GitHub release page is live with full CHANGELOG.
- [ ] README hero takes < 60s to understand what CrewSwarm does.
- [ ] Fresh clone → `npm install` → `npm start` works end-to-end from README alone.
