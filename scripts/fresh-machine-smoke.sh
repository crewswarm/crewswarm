#!/usr/bin/env bash
# fresh-machine-smoke.sh — Clone-to-first-build verification on a clean environment.
#
# Simulates a brand-new machine: temp dir, no existing config, fresh install.
# Requires GROQ_API_KEY in the environment (only external dependency).
#
# Usage:
#   GROQ_API_KEY=gsk_... bash scripts/fresh-machine-smoke.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
#
# What it tests:
#   1. Prerequisites (Node ≥ 20, git)
#   2. Clone into a temp dir
#   3. npm ci
#   4. Bootstrap minimal config (token + Groq key)
#   5. openswitchctl doctor (config blockers only — services not started yet)
#   6. Start the full stack
#   7. Wait for agents to connect
#   8. Dispatch one task to crew-coder → verify output file
#   9. Dispatch one task to crew-main  → verify text reply
#  10. Teardown
#
# Transcript is printed to stdout; pipe to tee to capture:
#   GROQ_API_KEY=... bash scripts/fresh-machine-smoke.sh | tee /tmp/fresh-machine-run.txt

set -euo pipefail

# ── Colour helpers ──────────────────────────────────────────────────────────
GRN="\033[32m" RED="\033[31m" YLW="\033[33m" BLD="\033[1m" RST="\033[0m" DIM="\033[2m"
pass()  { printf "${GRN}✅ ${RST}%s\n" "$1"; }
fail()  { printf "${RED}❌ ${RST}${BLD}%s${RST}\n" "$1"; FAILED=$((FAILED+1)); }
warn()  { printf "${YLW}⚠️  ${RST}%s\n" "$1"; }
step()  { printf "\n${BLD}${DIM}── %s ──${RST}\n" "$1"; }
banner(){ printf "\n${BLD}%s${RST}\n" "$1"; }
FAILED=0

# ── Config ──────────────────────────────────────────────────────────────────
REPO_URL="${FRESH_SMOKE_REPO:-https://github.com/CrewSwarm/CrewSwarm.git}"
GROQ_API_KEY="${GROQ_API_KEY:-}"
RT_TOKEN="fresh-smoke-$(openssl rand -hex 8 2>/dev/null || echo 'testtoken')"
TIMEOUT_AGENTS=120   # seconds to wait for agents to connect
TIMEOUT_TASK=90      # seconds to wait for smoke dispatch

banner "🧪 CrewSwarm Fresh-Machine Smoke  $(date -u '+%Y-%m-%d %H:%M UTC')"
printf "${DIM}Repo:  %s${RST}\n" "$REPO_URL"
printf "${DIM}Token: %s${RST}\n" "$RT_TOKEN"

# ── 1. Prerequisites ────────────────────────────────────────────────────────
step "1 · Prerequisites"

NODE="${NODE:-node}"
if ! command -v "$NODE" &>/dev/null; then
  fail "Node.js not found — install v20+: https://nodejs.org"
  exit 1
fi
NODE_VER=$("$NODE" --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js v$NODE_VER — need v20+"; exit 1
fi
pass "Node.js v$NODE_VER"

if ! command -v git &>/dev/null; then
  fail "git not found"; exit 1
fi
pass "git $(git --version | awk '{print $3}')"

if [[ -z "$GROQ_API_KEY" ]]; then
  warn "GROQ_API_KEY not set — LLM calls will fail. Set it and re-run."
  warn "  export GROQ_API_KEY=gsk_..."
  # Don't exit — doctor/config checks can still run
fi

# ── 2. Clone ────────────────────────────────────────────────────────────────
step "2 · Clone"
WORK_DIR=$(mktemp -d)
CLONE_DIR="$WORK_DIR/CrewSwarm"
trap 'echo ""; warn "Cleaning up $WORK_DIR ..."; kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK_DIR"' EXIT

printf "${DIM}  Cloning into %s ...${RST}\n" "$CLONE_DIR"
if git clone --depth=1 "$REPO_URL" "$CLONE_DIR" --quiet 2>&1; then
  pass "Cloned $REPO_URL → $CLONE_DIR"
else
  fail "git clone failed"; exit 1
fi

cd "$CLONE_DIR"

# ── 3. npm install ──────────────────────────────────────────────────────────
step "3 · npm install"
if npm ci --prefer-offline --silent 2>&1 | tail -3; then
  pass "npm ci succeeded"
else
  fail "npm ci failed"; exit 1
fi

# ── 4. Bootstrap config ─────────────────────────────────────────────────────
step "4 · Bootstrap config"
CFG_DIR="$WORK_DIR/.crewswarm"
mkdir -p "$CFG_DIR"

# Redirect config to temp dir for isolation
export HOME="$WORK_DIR"
export CREWSWARM_DIR="$CLONE_DIR"
export CREWSWARM_CONFIG_DIR="$CFG_DIR"

# config.json — RT token
printf '{"rt":{"authToken":"%s"}}\n' "$RT_TOKEN" > "$CFG_DIR/config.json"
pass "config.json — RT token written"

# crewswarm.json — Groq provider + 5 core agents
node -e "
  const fs = require('fs');
  const key = process.env.GROQ_API_KEY || '';
  const cfg = {
    _note: 'fresh-machine-smoke bootstrap',
    agents: [
      { id: 'crew-lead',  model: 'groq/llama-3.3-70b-versatile' },
      { id: 'crew-main',  model: 'groq/llama-3.3-70b-versatile' },
      { id: 'crew-coder', model: 'groq/llama-3.3-70b-versatile' },
      { id: 'crew-qa',    model: 'groq/llama-3.3-70b-versatile' },
      { id: 'crew-fixer', model: 'groq/llama-3.3-70b-versatile' },
      { id: 'crew-pm',    model: 'groq/llama-3.3-70b-versatile' },
    ],
    providers: {
      groq: { apiKey: key, baseUrl: 'https://api.groq.com/openai/v1' }
    }
  };
  fs.writeFileSync(process.env.CREWSWARM_CONFIG_DIR + '/crewswarm.json', JSON.stringify(cfg, null, 2));
"
pass "crewswarm.json — Groq + 5 agents written"

# cmd-allowlist
printf '{"patterns":["npm *","node *","npx *"]}\n' > "$CFG_DIR/cmd-allowlist.json"
printf '{}' > "$CFG_DIR/agent-prompts.json"
pass "cmd-allowlist.json + agent-prompts.json written"

# ── 5. openswitchctl doctor (config only — services not started) ────────────
step "5 · openswitchctl doctor"
CTL="$CLONE_DIR/scripts/openswitchctl"
chmod +x "$CTL"

# doctor exits 1 if blockers exist; warnings about services down are expected here
if bash "$CTL" doctor 2>&1; then
  pass "doctor — all config checks passed"
else
  # Warnings about services not running are normal at this stage — check if any CONFIG blockers
  doctor_out=$(bash "$CTL" doctor 2>&1 || true)
  echo "$doctor_out"
  if echo "$doctor_out" | grep -q "❌"; then
    fail "doctor — config blockers present (see above)"
    exit 1
  else
    pass "doctor — config OK (services not yet started, as expected)"
  fi
fi

# ── 6. Start the stack ──────────────────────────────────────────────────────
step "6 · Start stack"
export CREWSWARM_RT_AUTH_TOKEN="$RT_TOKEN"
export CREWSWARM_RT_REQUIRE_TOKEN=1
export CREWSWARM_RT_URL="ws://127.0.0.1:18889"
export CREWSWARM_OPENCODE_ENABLED=0
export CREW_LEAD_URL="http://127.0.0.1:5010"

"$NODE" "$CLONE_DIR/scripts/opencrew-rt-daemon.mjs" >> /tmp/fresh-smoke-rt.log 2>&1 &
sleep 3
"$NODE" "$CLONE_DIR/crew-lead.mjs" >> /tmp/fresh-smoke-lead.log 2>&1 &
sleep 2
"$NODE" "$CLONE_DIR/scripts/start-crew.mjs" >> /tmp/fresh-smoke-bridges.log 2>&1
sleep 5
pass "Stack processes started"

# ── 7. Wait for agents ──────────────────────────────────────────────────────
step "7 · Wait for agents to connect"
T_END=$((SECONDS + TIMEOUT_AGENTS))
CONNECTED=false
printf "  Polling RT bus"
while [[ $SECONDS -lt $T_END ]]; do
  STATUS=$(curl -sf http://127.0.0.1:18889/status 2>/dev/null || echo '{}')
  if echo "$STATUS" | grep -q '"crew-coder"' && echo "$STATUS" | grep -q '"crew-main"'; then
    CONNECTED=true
    printf "\n"
    break
  fi
  printf "."
  sleep 3
done

if [[ "$CONNECTED" == "true" ]]; then
  AGENT_COUNT=$(echo "$STATUS" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log((j.agents||[]).length);}catch{console.log(0);}})" 2>/dev/null || echo "?")
  pass "Agents connected ($AGENT_COUNT online)"
else
  fail "Agents did not connect within ${TIMEOUT_AGENTS}s"
  printf "${DIM}RT log:${RST}\n"; tail -20 /tmp/fresh-smoke-rt.log || true
  printf "${DIM}Bridge log:${RST}\n"; tail -20 /tmp/fresh-smoke-bridges.log || true
  exit 1
fi

# ── 8. Dispatch → crew-coder ─────────────────────────────────────────────────
step "8 · Dispatch → crew-coder (file write)"
RUN_ID="fm$(date +%s | tail -c 6)"
OUT_FILE="$CLONE_DIR/test-output/fresh-smoke/coder-${RUN_ID}.txt"
EXPECTED="FRESH_SMOKE_OK_${RUN_ID}"
mkdir -p "$(dirname "$OUT_FILE")"

TASK_TEXT="Create this file with @@WRITE_FILE: ${OUT_FILE}
Write exactly one line: ${EXPECTED}
No extra text."

printf "  Dispatching to crew-coder ...\n"
DISPATCH_REPLY=$(
  timeout "$TIMEOUT_TASK" "$NODE" "$CLONE_DIR/gateway-bridge.mjs" \
    --send crew-coder "$TASK_TEXT" 2>/dev/null || echo ""
)

# Give file system a moment
sleep 3

if [[ -f "$OUT_FILE" ]] && grep -q "$EXPECTED" "$OUT_FILE" 2>/dev/null; then
  pass "crew-coder wrote $OUT_FILE with correct content"
else
  fail "crew-coder did not produce $OUT_FILE with '$EXPECTED'"
  printf "${DIM}Reply: %s${RST}\n" "${DISPATCH_REPLY:0:200}"
  FAILED=$((FAILED+1))
fi

# ── 9. Dispatch → crew-main (text reply) ────────────────────────────────────
step "9 · Dispatch → crew-main (text reply)"
MARKER="MAIN_OK_${RUN_ID}"
printf "  Dispatching to crew-main ...\n"
MAIN_REPLY=$(
  timeout "$TIMEOUT_TASK" "$NODE" "$CLONE_DIR/gateway-bridge.mjs" \
    --send crew-main "Reply with exactly: $MARKER" 2>/dev/null || echo ""
)

if echo "$MAIN_REPLY" | grep -q "$MARKER"; then
  pass "crew-main replied with $MARKER"
else
  fail "crew-main did not reply with '$MARKER'"
  printf "${DIM}Reply: %s${RST}\n" "${MAIN_REPLY:0:200}"
  FAILED=$((FAILED+1))
fi

# ── 10. Summary ──────────────────────────────────────────────────────────────
banner "━━━ Fresh-Machine Smoke Results ━━━"
if [[ "$FAILED" -eq 0 ]]; then
  printf "${GRN}${BLD}✅ All checks passed — CrewSwarm works on a clean install.${RST}\n\n"
  exit 0
else
  printf "${RED}${BLD}❌ $FAILED check(s) failed.${RST}\n\n"
  exit 1
fi
