#!/usr/bin/env bash
# Restart the full CrewSwarm stack using only repo scripts (OpenCode, RT daemon, gateways, crew-lead, dashboard).
# Run from repo root: ./scripts/restart-all-from-repo.sh
# Optional: pass --no-dashboard to skip starting the dashboard.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
export OPENCLAW_DIR="$REPO_DIR"
export NODE="${NODE:-node}"

echo "Stopping existing CrewSwarm processes..."
pkill -f "gateway-bridge.mjs --rt-daemon" 2>/dev/null || true
pkill -f "opencrew-rt-daemon.mjs" 2>/dev/null || true
pkill -f "crew-lead.mjs" 2>/dev/null || true
pkill -f "scripts/dashboard.mjs" 2>/dev/null || true
pkill -f "opencode serve" 2>/dev/null || true
sleep 2

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
nohup "$NODE" crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &
sleep 1

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
echo "  OpenCode:   port 4096  (opencode serve — sessions, MCP)"
echo "  RT bus:     port 18889 (opencrew-rt-daemon.mjs)"
echo "  crew-lead:  port 5010  (chat + receives agent replies)"
echo "  dashboard:  port 4319  (Chat tab, RT Messages, Services)"
echo "  bridges:    node scripts/start-crew.mjs --status"
echo ""
echo "Logs: /tmp/opencode.log /tmp/opencrew-rt-daemon.log /tmp/crew-lead.log /tmp/dashboard.log"
