# Fresh-Machine Verification

This document describes how to verify CrewSwarm works on a completely clean install — no prior config, no existing `~/.crewswarm/`, cloned from scratch.

---

## Quick run

```bash
# Only external dependency: a Groq API key (free → https://console.groq.com/keys)
GROQ_API_KEY=gsk_... bash scripts/fresh-machine-smoke.sh
```

Save the transcript:

```bash
GROQ_API_KEY=gsk_... bash scripts/fresh-machine-smoke.sh | tee /tmp/fresh-machine-run.txt
```

---

## What the script tests

| Step | Check |
|------|-------|
| 1 | Node.js ≥ 20 + git installed |
| 2 | `git clone --depth=1` succeeds |
| 3 | `npm ci` installs all dependencies |
| 4 | Minimal config bootstrapped (token + Groq key) |
| 5 | `openswitchctl doctor` — zero config blockers |
| 6 | Full stack starts (RT daemon, crew-lead, bridges) |
| 7 | `crew-coder` and `crew-main` connect to RT bus within 2 min |
| 8 | Dispatch → `crew-coder` → file written with exact content |
| 9 | Dispatch → `crew-main` → exact text reply received |

The script exits 0 only if all nine steps pass. Every failure prints the specific log lines.

---

## Expected transcript

```
🧪 CrewSwarm Fresh-Machine Smoke  2026-02-23 07:00 UTC
Repo:  https://github.com/CrewSwarm/CrewSwarm.git
Token: fresh-smoke-a1b2c3d4e5f6g7h8

── 1 · Prerequisites ──
✅ Node.js v22.3.0
✅ git 2.44.0

── 2 · Clone ──
  Cloning into /tmp/tmp.XXXXXX/CrewSwarm ...
✅ Cloned https://github.com/CrewSwarm/CrewSwarm.git → /tmp/tmp.XXXXXX/CrewSwarm

── 3 · npm install ──
✅ npm ci succeeded

── 4 · Bootstrap config ──
✅ config.json — RT token written
✅ crewswarm.json — Groq + 5 agents written
✅ cmd-allowlist.json + agent-prompts.json written

── 5 · openswitchctl doctor ──

🩺  CrewSwarm Doctor — preflight check

✅ Node.js v22.3.0
✅ Repo dir: /tmp/tmp.XXXXXX/CrewSwarm
✅ Key files present (crew-lead, gateway-bridge, start-crew, dashboard, rt-daemon, package.json)
✅ node_modules installed
✅ Config dir: /tmp/tmp.XXXXXX/.crewswarm
✅ RT auth token: set (24 chars)
✅ crewswarm.json present
✅ LLM providers with keys: groq
✅ cmd-allowlist.json present
✅ Repo dir writable
✅ Config dir writable

Services (start with: openswitchctl start)
⚠️  RT bus not running (port 18889)
   openswitchctl start   or: node .../scripts/opencrew-rt-daemon.mjs &
⚠️  crew-lead not running (port 5010)
   node .../crew-lead.mjs &   or: openswitchctl start
⚠️  Dashboard not running (port 4319)
   node .../scripts/dashboard.mjs &   or: openswitchctl start

⚠️  Ready with 3 warning(s) — services may not be running yet.

✅ doctor — config OK (services not yet started, as expected)

── 6 · Start stack ──
✅ Stack processes started

── 7 · Wait for agents to connect ──
  Polling RT bus.........
✅ Agents connected (6 online)

── 8 · Dispatch → crew-coder (file write) ──
  Dispatching to crew-coder ...
✅ crew-coder wrote .../test-output/fresh-smoke/coder-123456.txt with correct content

── 9 · Dispatch → crew-main (text reply) ──
  Dispatching to crew-main ...
✅ crew-main replied with MAIN_OK_123456

━━━ Fresh-Machine Smoke Results ━━━
✅ All checks passed — CrewSwarm works on a clean install.
```

---

## Failure modes and fixes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `npm ci failed` | Locked dependencies out of date | `npm install && git add package-lock.json && git commit` |
| `doctor — config blockers` | Missing file or unwritable dir | Follow the `Fix:` hint printed by doctor |
| `Agents did not connect within 120s` | RT token mismatch or bridge crash | Check `/tmp/fresh-smoke-rt.log` and `/tmp/fresh-smoke-bridges.log` |
| `crew-coder did not produce file` | OpenCode enabled, Groq key missing, or LLM refused task | Confirm `GROQ_API_KEY` is valid; check bridge log |
| `crew-main did not reply` | LLM timeout or rate limit | Retry; if persistent, check Groq quota |

---

## Running in CI

The script is intentionally separate from the regular `npm run smoke` (which assumes the stack is already running). To run both in CI:

```yaml
- name: Fresh-machine smoke
  env:
    GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
  run: bash scripts/fresh-machine-smoke.sh
```

Note: this takes ~3–4 minutes per run (clone + install + agent startup). Run it on a schedule or pre-release, not on every PR.

---

## Manual step-by-step equivalent

If the script fails and you need to debug interactively:

```bash
# 1. Clone fresh
git clone https://github.com/CrewSwarm/CrewSwarm.git /tmp/cs-test
cd /tmp/cs-test
npm ci

# 2. Bootstrap
mkdir -p ~/.crewswarm
echo '{"rt":{"authToken":"my-test-token"}}' > ~/.crewswarm/config.json
# Add Groq key via dashboard or edit crewswarm.json manually

# 3. Doctor
bash scripts/openswitchctl doctor

# 4. Start
npm run restart-all

# 5. Verify
npm run smoke
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All 9 checks passed |
| `1` | One or more checks failed — see output for details |
