#!/usr/bin/env bash
# Restart crew-lead using PID file for reliable process management
# This prevents accidentally killing the dashboard when restarting crew-lead

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CREWSWARM_DIR="${CREWSWARM_DIR:-${OPENCLAW_DIR:-$REPO_ROOT}}"
CREW_LEAD_SCRIPT="$CREWSWARM_DIR/crew-lead.mjs"
LOG_FILE="/tmp/crew-lead.log"
PID_FILE="$HOME/.crewswarm/logs/crew-lead.pid"
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"
export PATH
LAUNCH_LABEL="com.crewswarm.crew-lead"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
RESOLVE_NODE_BIN="$CREWSWARM_DIR/scripts/resolve-node-bin.sh"
NODE_BIN="${NODE:-}"
if [[ -z "$NODE_BIN" ]]; then
  if [[ -x "$RESOLVE_NODE_BIN" ]]; then
    NODE_BIN="$("$RESOLVE_NODE_BIN")"
  elif command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x /usr/local/bin/node ]]; then
    NODE_BIN="/usr/local/bin/node"
  elif [[ -x /opt/homebrew/bin/node ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
  else
    echo "❌ node not found in PATH"
    exit 1
  fi
fi

# Stop every way crew-lead might be running and free :5010 (launchd alone does not
# kill a nohup/manual node crew-lead.mjs, which causes "Port 5010 in use" on kickstart).
stop_crew_lead_processes() {
  echo "  → Stopping existing crew-lead processes..."
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "  → Found crew-lead PID $PID from PID file"
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "" > "$PID_FILE" 2>/dev/null || true
  fi
  pkill -9 -f "crew-lead.mjs" 2>/dev/null || true
  if lsof -i :5010 -sTCP:LISTEN -t &>/dev/null; then
    echo "  → Releasing port 5010 (listener still present)..."
    lsof -ti :5010 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  fi
  local n=0
  while lsof -i :5010 -sTCP:LISTEN -t &>/dev/null && [ "$n" -lt 60 ]; do
    sleep 0.25
    n=$((n + 1))
  done
}

echo "🔄 Restarting crew-lead..."

if launchctl list "$LAUNCH_LABEL" >/dev/null 2>&1 || [[ -f "$LAUNCH_PLIST" ]]; then
  echo "  → Using launchd agent: $LAUNCH_LABEL"
  launchctl bootout "gui/$(id -u)" "$LAUNCH_PLIST" 2>/dev/null || true
  stop_crew_lead_processes
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"
  sleep 2
  if lsof -i :5010 -sTCP:LISTEN -t &>/dev/null; then
    echo "✅ crew-lead is running at http://127.0.0.1:5010"
    echo "   Log: $LOG_FILE"
    echo "   LaunchAgent: $LAUNCH_PLIST"
    exit 0
  fi
  echo "❌ crew-lead launchd start failed. Check log:"
  echo "   tail -20 $LOG_FILE"
  exit 1
fi

stop_crew_lead_processes

# Step 4: Start fresh crew-lead
echo "  → Starting crew-lead at $CREW_LEAD_SCRIPT..."
cd "$CREWSWARM_DIR"
nohup "$NODE_BIN" "$CREW_LEAD_SCRIPT" >> "$LOG_FILE" 2>&1 &

# Step 5: Wait for startup and verify
echo "  → Verifying startup..."
sleep 3

if lsof -i :5010 -sTCP:LISTEN -t &>/dev/null; then
  echo "✅ crew-lead is running at http://127.0.0.1:5010"
  echo "   Log: $LOG_FILE"
  echo "   PID file: $PID_FILE"
  exit 0
else
  echo "❌ crew-lead failed to start. Check log:"
  echo "   tail -20 $LOG_FILE"
  exit 1
fi
