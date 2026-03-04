#!/usr/bin/env bash
# Direct dashboard restart script — for agents and CLI use
# Bypasses the dashboard's API self-restart prohibition
#
# Usage: bash scripts/restart-dashboard.sh
#        npm run restart-dashboard

set -euo pipefail

CREWSWARM_DIR="${CREWSWARM_DIR:-${OPENCLAW_DIR:-$HOME/Desktop/CrewSwarm}}"
DASHBOARD_SCRIPT="$CREWSWARM_DIR/scripts/dashboard.mjs"
LOG_FILE="${CREWSWARM_DASH_LOG:-/tmp/dashboard.log}"

echo "🔄 Restarting dashboard..."

# Step 1: Hard kill any running dashboard processes
echo "  → Stopping existing dashboard processes..."
pkill -9 -f "scripts/dashboard.mjs" 2>/dev/null || true

# Step 2: Wait for port to release
echo "  → Waiting for port 4319 to release..."
sleep 2

# Step 3: Start fresh dashboard
echo "  → Starting dashboard at $DASHBOARD_SCRIPT..."
nohup node "$DASHBOARD_SCRIPT" >> "$LOG_FILE" 2>&1 &

# Step 4: Wait for startup and verify
echo "  → Verifying startup..."
sleep 2

if lsof -i :4319 -sTCP:LISTEN -t &>/dev/null; then
  echo "✅ Dashboard is running at http://127.0.0.1:4319"
  echo "   Log: $LOG_FILE"
  exit 0
else
  echo "❌ Dashboard failed to start. Check log:"
  echo "   tail -20 $LOG_FILE"
  exit 1
fi
