#!/usr/bin/env bash
# Restart crew-lead using PID file for reliable process management
# This prevents accidentally killing the dashboard when restarting crew-lead

set -euo pipefail

CREWSWARM_DIR="${CREWSWARM_DIR:-$HOME/Desktop/CrewSwarm}"
CREW_LEAD_SCRIPT="$CREWSWARM_DIR/crew-lead.mjs"
LOG_FILE="/tmp/crew-lead.log"
PID_FILE="$HOME/.crewswarm/logs/crew-lead.pid"

echo "🔄 Restarting crew-lead..."

# Step 1: Try to kill via PID file first (safest method)
echo "  → Stopping existing crew-lead processes..."
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "  → Found crew-lead PID $PID from PID file"
    kill -9 "$PID" 2>/dev/null || true
    echo "" > "$PID_FILE"  # Clear PID file
  else
    echo "  → PID file exists but process not running (cleaning up stale PID)"
    echo "" > "$PID_FILE"
  fi
else
  echo "  → No PID file found, using fallback pattern match"
fi

# Step 2: Fallback pattern-based kill (only if PID method didn't work)
pkill -9 -f "crew-lead.mjs" 2>/dev/null || true

# Step 3: Wait for port to release
echo "  → Waiting for port 5010 to release..."
sleep 2

# Step 4: Start fresh crew-lead
echo "  → Starting crew-lead at $CREW_LEAD_SCRIPT..."
cd "$CREWSWARM_DIR"
nohup node "$CREW_LEAD_SCRIPT" >> "$LOG_FILE" 2>&1 &

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
