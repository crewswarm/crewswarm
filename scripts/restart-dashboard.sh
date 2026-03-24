#!/usr/bin/env bash
# Direct dashboard restart script — for agents and CLI use
# Bypasses the dashboard's API self-restart prohibition
#
# Usage: bash scripts/restart-dashboard.sh
#        npm run restart-dashboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CREWSWARM_DIR="${CREWSWARM_DIR:-${OPENCLAW_DIR:-$REPO_ROOT}}"
DASHBOARD_SCRIPT="$CREWSWARM_DIR/scripts/dashboard.mjs"
LOG_FILE="${CREWSWARM_DASH_LOG:-/tmp/dashboard.log}"
HEALTH_URL="${CREWSWARM_DASH_HEALTH_URL:-http://127.0.0.1:4319/api/health}"
NODE_BIN="${NODE:-$("$CREWSWARM_DIR/scripts/resolve-node-bin.sh")}"
LAUNCH_LABEL="com.crewswarm.dashboard"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist"

wait_for_dashboard() {
  local pid="$1"
  local attempts="${2:-15}"

  for ((i=1; i<=attempts; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "  → Dashboard process exited before becoming healthy"
      return 1
    fi

    if curl -sSf -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  echo "  → Dashboard did not pass health check at $HEALTH_URL"
  return 1
}

start_dashboard() {
  export NODE_DISABLE_COMPILE_CACHE=1
  if command -v setsid >/dev/null 2>&1; then
    setsid "$NODE_BIN" "$DASHBOARD_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "$NODE_BIN" "$DASHBOARD_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $!
}

echo "🔄 Restarting dashboard..."

if launchctl list "$LAUNCH_LABEL" >/dev/null 2>&1 || [[ -f "$LAUNCH_PLIST" ]]; then
  echo "  → Using launchd agent: $LAUNCH_LABEL"
  launchctl bootout "gui/$(id -u)" "$LAUNCH_PLIST" 2>/dev/null || true
  pkill -9 -f "scripts/dashboard.mjs" 2>/dev/null || true
  lsof -ti :4319 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 2
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"
  for _ in $(seq 1 20); do
    if curl -sSf -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "✅ Dashboard is running at http://127.0.0.1:4319"
      echo "   Log: $LOG_FILE"
      echo "   LaunchAgent: $LAUNCH_PLIST"
      exit 0
    fi
    sleep 1
  done
  echo "❌ Dashboard launchd start failed. Check log:"
  tail -20 "$LOG_FILE" || true
  exit 1
fi

echo "  → Stopping existing dashboard processes..."
pkill -9 -f "scripts/dashboard.mjs" 2>/dev/null || true

echo "  → Waiting for port 4319 to release..."
sleep 2

# Step 3: Start fresh dashboard
echo "  → Starting dashboard at $DASHBOARD_SCRIPT..."
DASH_PID="$(start_dashboard)"

# Step 4: Wait for startup and verify
echo "  → Verifying startup..."
if wait_for_dashboard "$DASH_PID"; then
  sleep 3
  if ! kill -0 "$DASH_PID" 2>/dev/null; then
    echo "❌ Dashboard exited shortly after startup. Check log:"
    tail -20 "$LOG_FILE" || true
    exit 1
  fi
  echo "✅ Dashboard is running at http://127.0.0.1:4319"
  echo "   PID: $DASH_PID"
  echo "   Log: $LOG_FILE"
  exit 0
else
  echo "❌ Dashboard failed to start. Check log:"
  tail -20 "$LOG_FILE" || true
  exit 1
fi
