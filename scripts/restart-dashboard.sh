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
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$DASHBOARD_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node "$DASHBOARD_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $!
}

echo "🔄 Restarting dashboard..."

# Step 1: Hard kill any running dashboard processes
echo "  → Stopping existing dashboard processes..."
pkill -9 -f "scripts/dashboard.mjs" 2>/dev/null || true

# Step 2: Wait for port to release
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
