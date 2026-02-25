#!/usr/bin/env bash
# Restart the full CrewSwarm stack using only repo scripts (OpenCode, RT daemon, gateways, crew-lead, dashboard).
# Run from repo root: ./scripts/restart-all-from-repo.sh
# Optional: pass --no-dashboard to skip starting the dashboard.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
export CREWSWARM_DIR="$REPO_DIR"
export OPENCLAW_DIR="$REPO_DIR"   # backward compat for scripts that only check this
export NODE="${NODE:-node}"

echo "Stopping existing CrewSwarm processes..."
# Kill by port first (catches zombies that survive name-based pkill)
lsof -ti :5010  2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :4319  2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :18889 2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :4096  2>/dev/null | xargs kill -9 2>/dev/null; true
# Kill by process name
pkill -9 -f "gateway-bridge.mjs" 2>/dev/null; true
pkill -9 -f "opencrew-rt-daemon.mjs" 2>/dev/null; true
pkill -9 -f "crew-lead.mjs" 2>/dev/null; true
pkill -9 -f "scripts/dashboard.mjs" 2>/dev/null; true
pkill -9 -f "opencode serve" 2>/dev/null; true
# Remove stale PID files
find /tmp -maxdepth 1 -name "bridge-*.pid" -delete 2>/dev/null; true
sleep 2
# Confirm ports are clear before starting
for port in 5010 4319 18889 4096; do
  HELD=$(lsof -ti :$port 2>/dev/null | wc -l | tr -d ' ')
  if [ "$HELD" -gt 0 ]; then
    echo "  WARNING: port $port still held by $HELD process(es) — force killing..."
    lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null; true
  fi
done

echo "Starting OpenCode server (port 4096)..."
OPENCODE_BIN="$(command -v opencode 2>/dev/null)" || OPENCODE_BIN="/usr/local/bin/opencode"
if [[ -x "$OPENCODE_BIN" ]]; then
  nohup "$OPENCODE_BIN" serve --port 4096 --hostname 127.0.0.1 >> /tmp/opencode.log 2>&1 &
  sleep 1
else
  echo "  (opencode not found; skip)"
fi

echo "Starting RT daemon (port 18889)..."
nohup "$NODE" scripts/opencrew-rt-daemon.mjs >> /tmp/opencrew-rt-daemon.log 2>&1 &
sleep 2

echo "Starting gateway bridges (crew-main, crew-pm, crew-coder, etc.)..."
"$NODE" scripts/start-crew.mjs
sleep 1

echo "Starting crew-lead (port 5010)..."
# crew-lead is spawned by start-crew.mjs above; this is a safety net only.
if ! lsof -ti :5010 >/dev/null 2>&1; then
  nohup "$NODE" crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &
  sleep 1
fi

START_DASH=1
for arg in "$@"; do
  if [[ "$arg" == "--no-dashboard" ]]; then START_DASH=0; fi
done

if [[ "$START_DASH" -eq 1 ]]; then
  echo "Starting dashboard (port 4319)..."
  nohup "$NODE" scripts/dashboard.mjs >> /tmp/dashboard.log 2>&1 &
  sleep 1
  echo ""
  echo "Dashboard: http://127.0.0.1:4319"
fi

echo ""
echo "Stack restarted from repo. Check:"
echo "  OpenCode:   port 4096  (opencode serve — sessions, MCP, --attach target)"
echo "  RT bus:     port 18889 (opencrew-rt-daemon.mjs)"
echo "  crew-lead:  port 5010  (chat + receives agent replies)"
echo "  dashboard:  port 4319  (Chat tab, RT Messages, Services)"
echo "  bridges:    node scripts/start-crew.mjs --status"
echo ""
echo "Logs: /tmp/opencode.log /tmp/opencrew-rt-daemon.log /tmp/crew-lead.log /tmp/dashboard.log"
