#!/usr/bin/env bash
# Restart the full crewswarm stack using only repo scripts (OpenCode, RT daemon, gateways, crew-lead, dashboard, Vibe, watch).
# Run from repo root: ./scripts/restart-all-from-repo.sh
# Optional: --no-dashboard  skip dashboard
#           --no-studio    skip Vibe + file watcher
#           --no-bridges   skip Telegram + WhatsApp bridges

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
export CREWSWARM_DIR="$REPO_DIR"
export OPENCLAW_DIR="$REPO_DIR"   # backward compat for scripts that only check this
export NODE="$("$REPO_DIR/scripts/resolve-node-bin.sh")"
# Work around intermittent Node 24/25 ESM loader crashes (`Unknown system error -11, read`)
# seen in the RT daemon and Vibe startup paths on this machine.
export NODE_DISABLE_COMPILE_CACHE="${NODE_DISABLE_COMPILE_CACHE:-1}"

# ── Color helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Service status tracking (bash 3.2 compatible — no associative arrays) ────
svc_set() { eval "SVC_$(echo "$1" | tr '-' '_')=$2"; }
svc_get() { eval "echo \${SVC_$(echo "$1" | tr '-' '_'):-unknown}"; }

# ── Graceful kill: SIGTERM first, SIGKILL after 5s ────────────────────────────
graceful_kill_pattern() {
  local pattern="$1"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then return 0; fi
  # Send SIGTERM
  echo "$pids" | xargs kill -TERM 2>/dev/null || true
  # Wait up to 5s for processes to exit
  local waited=0
  while [[ $waited -lt 50 ]]; do
    if ! pgrep -f "$pattern" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  # Still alive — SIGKILL
  pgrep -f "$pattern" 2>/dev/null | xargs kill -9 2>/dev/null || true
}

graceful_kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then return 0; fi
  echo "$pids" | xargs kill -TERM 2>/dev/null || true
  local waited=0
  while [[ $waited -lt 50 ]]; do
    if ! lsof -ti :"$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  lsof -ti :"$port" 2>/dev/null | xargs kill -9 2>/dev/null || true
}

# ── Health polling: wait for a URL to respond 200 (or any 2xx/3xx) ────────────
wait_for_health() {
  local url="$1"
  local name="$2"
  local max_attempts="${3:-30}"
  local attempt=0
  while [ $attempt -lt $max_attempts ]; do
    if curl -s --max-time 2 "$url" > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓${RESET} $name is up"
      svc_set "$name" "up"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo -e "  ${RED}✗${RESET} $name failed to start (tried ${max_attempts}s)"
  svc_set "$name" "down"
  return 1
}

# ── Parse flags ───────────────────────────────────────────────────────────────
START_DASH=1
START_STUDIO=1
START_BRIDGES=1
for arg in "$@"; do
  case "$arg" in
    --no-dashboard) START_DASH=0 ;;
    --no-studio)    START_STUDIO=0 ;;
    --no-bridges)   START_BRIDGES=0 ;;
  esac
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Stop everything gracefully
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}Stopping existing crewswarm processes...${RESET}"

# ── Kill by process name (SIGTERM → SIGKILL) ─────────────────────────────────
# Use pattern without leading "node " so we catch all node binary paths
graceful_kill_pattern "gateway-bridge.mjs"
graceful_kill_pattern "opencrew-rt-daemon.mjs"
graceful_kill_pattern "crew-lead.mjs"
graceful_kill_pattern "scripts/dashboard.mjs"
graceful_kill_pattern "scripts/mcp-server.mjs"
graceful_kill_pattern "scripts/crew-scribe.mjs"
graceful_kill_pattern "telegram-bridge.mjs"
graceful_kill_pattern "whatsapp-bridge.mjs"
graceful_kill_pattern "opencode serve"
graceful_kill_pattern "pm-loop.mjs"
graceful_kill_pattern "node --test"        # orphaned test runners from dashboard
graceful_kill_pattern "npx playwright"     # orphaned playwright runners
graceful_kill_pattern "apps/vibe/server.mjs"
graceful_kill_pattern "watch-server.mjs"
graceful_kill_pattern "vite.*vibe"

# ── Kill by port (catches anything that survived — e.g. launchd-managed dashboard)
for port in 5010 4319 18889 4096 5020 3333 3334; do
  graceful_kill_port "$port"
done

# ── Clean stale PID files so start-crew doesn't skip re-spawning
find /tmp -maxdepth 1 -name "bridge-*.pid" -delete 2>/dev/null; true

sleep 1

# ── Confirm ports are clear ──────────────────────────────────────────────────
for port in 5010 4319 18889 4096 5020 3333 3334; do
  HELD=$(lsof -ti :$port 2>/dev/null | wc -l | tr -d ' ')
  if [ "$HELD" -gt 0 ]; then
    echo "  WARNING: port $port still held — force killing..."
    lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null; true
    sleep 1
  fi
done

echo "  All processes stopped."

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Start services in order with health polling
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}Starting services...${RESET}"

# ── 1. OpenCode (optional, non-critical) ─────────────────────────────────────
echo ""
echo "Starting optional OpenCode session server (port 4096)..."
OPENCODE_BIN="$(command -v opencode 2>/dev/null)" || OPENCODE_BIN="/usr/local/bin/opencode"
if [[ -x "$OPENCODE_BIN" ]]; then
  nohup "$OPENCODE_BIN" serve --port 4096 --hostname 127.0.0.1 >> /tmp/opencode.log 2>&1 &
  # Non-critical — don't block on health
  svc_set "opencode" "up"
  echo "  Started (PID $!)"
else
  echo "  (opencode not found; skip)"
  svc_set "opencode" "skip"
fi

# ── 2. RT daemon (port 18889) ────────────────────────────────────────────────
echo ""
echo "Starting RT daemon (port 18889)..."
nohup "$NODE" scripts/opencrew-rt-daemon.mjs >> /tmp/opencrew-rt-daemon.log 2>&1 &

if ! wait_for_health "http://127.0.0.1:18889/status" "rt-bus" 15; then
  echo "  Retrying RT daemon once..."
  graceful_kill_pattern "opencrew-rt-daemon.mjs"
  graceful_kill_port 18889
  sleep 1
  nohup "$NODE" scripts/opencrew-rt-daemon.mjs >> /tmp/opencrew-rt-daemon.log 2>&1 &
  if ! wait_for_health "http://127.0.0.1:18889/status" "rt-bus" 15; then
    echo "  Last RT log lines:"
    tail -n 40 /tmp/opencrew-rt-daemon.log 2>/dev/null || true
    echo ""
    echo -e "  ${RED}RT bus failed — continuing with remaining services${RESET}"
  fi
fi

# ── 3. Gateway bridges (agents) ──────────────────────────────────────────────
echo ""
echo "Starting gateway bridges (crew-main, crew-pm, crew-coder, etc.)..."
"$NODE" scripts/start-crew.mjs --force
svc_set "agents" "up"
sleep 1

# ── 4. crew-lead (port 5010) — CRITICAL ─────────────────────────────────────
echo ""
echo "Starting crew-lead (port 5010)..."
# crew-lead is spawned by start-crew.mjs above; this is a safety net only.
if ! lsof -ti :5010 >/dev/null 2>&1; then
  nohup "$NODE" crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &
fi
wait_for_health "http://127.0.0.1:5010/health" "crew-lead" 30 || true

# ── 5. Dashboard (port 4319) — CRITICAL ─────────────────────────────────────
if [[ "$START_DASH" -eq 1 ]]; then
  echo ""
  echo "Starting dashboard (port 4319)..."
  if launchctl list com.crewswarm.dashboard >/dev/null 2>&1; then
    launchctl stop com.crewswarm.dashboard 2>/dev/null; sleep 1
    launchctl start com.crewswarm.dashboard 2>/dev/null
    echo "  (via launchd)"
  else
    nohup "$NODE" scripts/dashboard.mjs >> /tmp/dashboard.log 2>&1 &
  fi
  wait_for_health "http://127.0.0.1:4319/" "dashboard" 30 || true
else
  svc_set "dashboard" "skip"
fi

# ── 6. Messaging bridges (Telegram + WhatsApp) ──────────────────────────────
if [[ "$START_BRIDGES" -eq 1 ]]; then
  echo ""
  # Verify RT bus is still up before starting bridges
  if [[ "$(svc_get rt-bus)" == "up" ]]; then
    echo "Starting Telegram bridge..."
    nohup "$NODE" "$REPO_DIR/telegram-bridge.mjs" >> /tmp/telegram-bridge.log 2>&1 &
    svc_set "telegram" "up"
    echo "  PID: $!"

    echo "Starting WhatsApp bridge..."
    nohup "$NODE" "$REPO_DIR/whatsapp-bridge.mjs" >> /tmp/whatsapp-bridge.log 2>&1 &
    svc_set "whatsapp" "up"
    echo "  PID: $!"
  else
    echo -e "  ${YELLOW}Skipping messaging bridges — RT bus is not up${RESET}"
    svc_set "telegram" "skip"
    svc_set "whatsapp" "skip"
  fi
fi

# ── 7. MCP + OpenAI-compat server (port 5020) ───────────────────────────────
echo ""
echo "Starting MCP + OpenAI-compat server (port 5020)..."
if ! lsof -ti :5020 >/dev/null 2>&1; then
  nohup "$NODE" scripts/mcp-server.mjs >> /tmp/crewswarm-mcp.log 2>&1 &
  wait_for_health "http://127.0.0.1:5020/health" "mcp-server" 15 || true
else
  echo "  (already running on :5020)"
  svc_set "mcp-server" "up"
fi

# ── 8. Vibe + file watcher (ports 3333, 3334) ───────────────────────────────
if [[ "$START_STUDIO" -eq 1 ]]; then
  echo ""
  echo "Starting Vibe + file watcher (ports 3333, 3334)..."
  if [[ ! -d "$REPO_DIR/apps/vibe/dist" ]]; then
    echo "  Building Vibe (first run)..."
    (cd "$REPO_DIR" && npm run vibe:build) >/dev/null 2>&1 || true
  fi
  sleep 1
  nohup "$NODE" "$REPO_DIR/apps/vibe/server.mjs" >> /tmp/studio.log 2>&1 &
  nohup env NODE_DISABLE_COMPILE_CACHE=1 "$NODE" "$REPO_DIR/apps/vibe/watch-server.mjs" >> /tmp/studio-watch.log 2>&1 &
  wait_for_health "http://127.0.0.1:3333/" "vibe-studio" 25 || true
  # Watch server doesn't have HTTP health — just check port
  for i in $(seq 1 10); do
    if lsof -ti :3334 >/dev/null 2>&1; then
      echo -e "  ${GREEN}✓${RESET} file watcher is up"
      svc_set "file-watcher" "up"
      break
    fi
    if [[ "$i" -eq 10 ]]; then
      echo -e "  ${YELLOW}!${RESET} file watcher not detected on :3334"
      svc_set "file-watcher" "down"
    fi
    sleep 1
  done
else
  svc_set "vibe-studio" "skip"
  svc_set "file-watcher" "skip"
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Summary
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}━━━ Service Summary ━━━${RESET}"

print_status() {
  local name="$1"
  local port="$2"
  local status="$(svc_get "$name")"
  case "$status" in
    up)   echo -e "  ${GREEN}✓${RESET} $name  :$port" ;;
    down) echo -e "  ${RED}✗${RESET} $name  :$port" ;;
    skip) echo -e "  ${YELLOW}-${RESET} $name  :$port  (skipped)" ;;
    *)    echo -e "  ${YELLOW}?${RESET} $name  :$port  (unknown)" ;;
  esac
}

print_status "rt-bus"       18889
print_status "crew-lead"    5010
print_status "dashboard"    4319
print_status "agents"       "--"
print_status "mcp-server"   5020
print_status "vibe-studio"  3333
print_status "file-watcher" 3334
print_status "opencode"     4096
if [[ "$START_BRIDGES" -eq 1 ]]; then
  print_status "telegram"   "--"
  print_status "whatsapp"   "--"
fi

echo ""
echo "Logs: /tmp/opencode.log /tmp/opencrew-rt-daemon.log /tmp/crew-lead.log /tmp/dashboard.log /tmp/crewswarm-mcp.log /tmp/studio.log /tmp/studio-watch.log"

# ── Run health-check if available ────────────────────────────────────────────
if [[ -f "$REPO_DIR/scripts/health-check.mjs" ]]; then
  echo ""
  echo -e "${BOLD}Running health check...${RESET}"
  sleep 2  # let services fully warm up
  "$NODE" "$REPO_DIR/scripts/health-check.mjs" --quiet 2>/dev/null || true
fi

# ── Exit code: 0 if critical services are up, 1 otherwise ────────────────────
CREW_LEAD_OK="$(svc_get crew-lead)"
DASHBOARD_OK="$(svc_get dashboard)"

if [[ "$CREW_LEAD_OK" == "up" ]] && { [[ "$DASHBOARD_OK" == "up" ]] || [[ "$START_DASH" -eq 0 ]]; }; then
  echo ""
  echo -e "${GREEN}${BOLD}All critical services are up.${RESET}"
  exit 0
else
  echo ""
  echo -e "${RED}${BOLD}One or more critical services failed to start.${RESET}"
  [[ "$CREW_LEAD_OK" != "up" ]] && echo -e "  ${RED}crew-lead is not responding — check /tmp/crew-lead.log${RESET}"
  [[ "$DASHBOARD_OK" != "up" && "$START_DASH" -eq 1 ]] && echo -e "  ${RED}dashboard is not responding — check /tmp/dashboard.log${RESET}"
  exit 1
fi
