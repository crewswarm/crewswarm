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

# ── Kill by process name first (don't rely on port — avoids killing unrelated listeners)
# Use pattern without leading "node " so we catch all node binary paths (/usr/local/bin/node,
# /usr/local/Cellar/node/x.y.z/bin/node, bare "node", etc.)
pkill -9 -f "gateway-bridge.mjs"      2>/dev/null; true  # all --rt-daemon AND --send stragglers
pkill -9 -f "opencrew-rt-daemon.mjs"  2>/dev/null; true
pkill -9 -f "crew-lead.mjs"           2>/dev/null; true
pkill -9 -f "scripts/dashboard.mjs"   2>/dev/null; true
pkill -9 -f "scripts/mcp-server.mjs"  2>/dev/null; true
pkill -9 -f "scripts/crew-scribe.mjs" 2>/dev/null; true  # was never killed; accumulated on restart
pkill -9 -f "telegram-bridge.mjs"     2>/dev/null; true  # catches all node binary path variants
pkill -9 -f "whatsapp-bridge.mjs"     2>/dev/null; true  # ditto
pkill -9 -f "opencode serve"          2>/dev/null; true
pkill -9 -f "pm-loop.mjs"             2>/dev/null; true  # NEVER auto-start PM loop

# ── Kill by port (catches anything that survived above — e.g. launchd-managed dashboard)
lsof -ti :5010  2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :4319  2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :18889 2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :4096  2>/dev/null | xargs kill -9 2>/dev/null; true
lsof -ti :5020  2>/dev/null | xargs kill -9 2>/dev/null; true

# ── Clean stale PID files so start-crew doesn't skip re-spawning
find /tmp -maxdepth 1 -name "bridge-*.pid" -delete 2>/dev/null; true

sleep 2

# ── Confirm ports are clear
for port in 5010 4319 18889 4096 5020; do
  HELD=$(lsof -ti :$port 2>/dev/null | wc -l | tr -d ' ')
  if [ "$HELD" -gt 0 ]; then
    echo "  WARNING: port $port still held — force killing..."
    lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null; true
    sleep 1
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
  # If a LaunchAgent manages the dashboard, use launchctl so we don't race with KeepAlive.
  # launchctl stop + start is idempotent and avoids the "two processes fight for port" problem.
  if launchctl list com.crewswarm.dashboard >/dev/null 2>&1; then
    launchctl stop com.crewswarm.dashboard 2>/dev/null; sleep 1
    launchctl start com.crewswarm.dashboard 2>/dev/null
    echo "  (via launchd — will be up in ~2s)"
  else
    nohup "$NODE" scripts/dashboard.mjs >> /tmp/dashboard.log 2>&1 &
    sleep 1
  fi
  echo ""
  echo "Dashboard: http://127.0.0.1:4319"
fi

START_BRIDGES=1
for arg in "$@"; do
  if [[ "$arg" == "--no-bridges" ]]; then START_BRIDGES=0; fi
done

if [[ "$START_BRIDGES" -eq 1 ]]; then
  echo "Starting Telegram bridge..."
  # Pattern without leading "node " to catch any node binary path variant
  pkill -9 -f "telegram-bridge.mjs" 2>/dev/null; sleep 1
  nohup "$NODE" "$REPO_DIR/telegram-bridge.mjs" >> /tmp/telegram-bridge.log 2>&1 &
  echo "  PID: $!"

  echo "Starting WhatsApp bridge..."
  pkill -9 -f "whatsapp-bridge.mjs" 2>/dev/null; sleep 1
  nohup "$NODE" "$REPO_DIR/whatsapp-bridge.mjs" >> /tmp/whatsapp-bridge.log 2>&1 &
  echo "  PID: $!"
fi

echo "Starting MCP + OpenAI-compat server (port 5020)..."
# Guard: mcp-server is also spawned by start-crew.mjs — only start if not already up
if ! lsof -ti :5020 >/dev/null 2>&1; then
  nohup "$NODE" scripts/mcp-server.mjs >> /tmp/crewswarm-mcp.log 2>&1 &
  sleep 1
else
  echo "  (already running on :5020)"
fi

echo ""
echo "Stack restarted from repo. Check:"
echo "  OpenCode:   port 4096  (opencode serve — sessions, MCP, --attach target)"
echo "  RT bus:     port 18889 (opencrew-rt-daemon.mjs)"
echo "  crew-lead:  port 5010  (chat + receives agent replies)"
echo "  dashboard:  port 4319  (Chat tab, RT Messages, Services)"
echo "  MCP/OpenAI: port 5020  (MCP tools + /v1/chat/completions for Open WebUI etc.)"
echo "  bridges:    node scripts/start-crew.mjs --status"
echo ""
echo "Logs: /tmp/opencode.log /tmp/opencrew-rt-daemon.log /tmp/crew-lead.log /tmp/dashboard.log /tmp/crewswarm-mcp.log"
