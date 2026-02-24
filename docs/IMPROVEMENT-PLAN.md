# CrewSwarm improvement plan (post–7.5 review)

Plan to address the five gaps and add tests for comparison. Run baseline tests before and after each fix.

---

## 1. Project / path confusion

**Problem:** ROADMAP at repo root vs `website/ROADMAP.md` vs per-project dirs caused ENOENT and “where did it go?” moments.

**Convention (target):**
- **One ROADMAP per outputDir.** Each project has exactly one `ROADMAP.md` at `<outputDir>/ROADMAP.md`.
- **Repo root:** `ROADMAP.md` at repo root (if present) is for **ops/core** work (CrewSwarm itself). `website/ROADMAP.md` is for the website project only. Do not assume “ROADMAP.md” without a path means repo root — prefer explicit path or “project’s outputDir”.
- **PM:** When task says “the roadmap” or “ROADMAP.md”, use context: if a project outputDir was given, use `<outputDir>/ROADMAP.md`; if in CrewSwarm repo context, use repo root `ROADMAP.md` or `website/ROADMAP.md` as documented.

**Tasks:**
- [ ] Add one short “Roadmap and paths” subsection to AGENTS.md: one ROADMAP per outputDir; repo root vs website vs project.
- [x] In PM prompt, add one sentence: “When a task refers to ‘the roadmap’ or ‘ROADMAP.md’, use the project’s outputDir when given; otherwise repo root ROADMAP.md is ops/core, website/ROADMAP.md is the website project.”
- [x] Ensure repo root `ROADMAP.md` exists (minimal) so PM never ENOENT on “CrewSwarm ROADMAP” (already done in prior session).

**Tests:**
- Unit: Given outputDir X, resolve “ROADMAP.md” → `X/ROADMAP.md`. Given “CrewSwarm repo”, resolve → repo root or website per convention.
- Smoke: PM task “read the roadmap” with outputDir set → no ENOENT; PM task “add item to roadmap” with outputDir → writes to correct file.

---

## 2. Agent “didn’t write” / permissions doc

**Problem:** PM lacking write_file caused “they said they did but nothing happened.” Defaults and prompts are aligned; no single doc for “who can write where.”

**Tasks:**
- [ ] Add **“Who can write where”** to AGENTS.md (or docs/AGENT-TOOLS.md): table Agent | write_file | mkdir | notes (e.g. PM: yes for new project folder + ROADMAP; for existing repo files must dispatch to copywriter/coder).
- [x] Optional: one sentence in PM prompt pointing to that doc.

**Tests:**
- Doc exists and lists crew-pm with write_file + mkdir and “for existing files dispatch to copywriter/coder”.
- Smoke: PM “create new project at /tmp/test-proj-xyz” → folder and ROADMAP.md exist; PM “add item to repo root ROADMAP” → dispatch to copywriter or write to repo root per convention.

---

## 3. Unanswered dispatches (timeout / never claimed)

**Problem:** If an agent is offline, dispatch hangs; no timeout or “never claimed” event.

**Tasks:**
- [x] **crew-lead:** When dispatching, record timestamp. On a timer (e.g. 90s) or when building next health snapshot, check `pendingDispatches`: if a dispatch is older than 90s and not done, emit a synthetic “task.timeout” or “task.never_claimed” (e.g. append to history, broadcast SSE) and optionally remove from pending.
- [x] **Config:** Add `CREWSWARM_DISPATCH_TIMEOUT_MS` (default 90000) in crew-lead or config.
- [ ] **Dashboard:** Optionally show “timed out” or “no reply” for tasks that hit this.

**Tests:**
- Unit: pendingDispatches entry older than timeout → synthetic event emitted, session history updated.
- Integration: Dispatch to a known-offline agent (or mock), wait 90s → crew-lead reports timeout/never claimed (no infinite hang).

---

## 4. Natural language → correct target

**Problem:** “Tell PM to add it” works via rules but is fragile; intent → action could be clearer.

**Tasks:**
- [ ] Add a short **“Intent → action”** block to crew-lead system prompt: table or bullets. Examples: “add to roadmap” / “update ROADMAP” → dispatch to PM with “dispatch to crew-copywriter to update <path> with …” OR direct to crew-copywriter with path + items; “create new project” → dispatch to PM (PM creates folder + ROADMAP + @@REGISTER_PROJECT); “who can write” → answer from “who can write where” doc.
- [x] Optional: 2–3 example user phrases and the exact Stinki action (dispatch to whom, with what task).

**Tests:**
- No automated test; manual: “add to roadmap: field matrix” and “create new project foo at Desktop” and “who can write ROADMAP” → correct target and outcome.

---

## 5. Telemetry / ops

**Problem:** Schema doc exists; wiring RT and dashboard to it and validation (e.g. check-dashboard) still ahead.

**Tasks:**
- [x] **RT / gateway:** Emit events that match docs/OPS-TELEMETRY-SCHEMA.md (envelope: schemaVersion, eventType, eventId, occurredAt, source, correlationId; types: agent.presence, task.lifecycle, error) where feasible without a full rewrite.
- [x] **Dashboard:** Consume or display one of the event types (e.g. task.lifecycle or agent.presence) so the pipeline is proven end-to-end.
- [x] **Validation:** Extend scripts/check-dashboard.mjs (or add scripts/check-telemetry.mjs) to validate a sample payload or schema version against the doc.

**Tests:**
- check-dashboard (or check-telemetry) runs and passes when sample payloads conform to schema.
- Optional: smoke that one event type appears in dashboard or in a log file after a dispatch.

---

## Test run for comparison

**Baseline (run before fixes):**
```bash
npm run smoke:dispatch   # if crew + RT up
node scripts/check-dashboard.mjs
node scripts/check-telemetry.mjs
node scripts/improvement-baseline-test.mjs
```

**After each fix:** Re-run the same commands and compare (smoke pass, check-dashboard pass, improvement-baseline passes more checks or reports expected behaviour).

See `scripts/improvement-baseline-test.mjs` for what the baseline test asserts (paths, docs existence, config keys, etc.).
