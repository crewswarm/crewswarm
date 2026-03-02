#!/usr/bin/env bash
# SwiftBar helper to restart services via Dashboard REST API
# Usage: swiftbar-restart-service.sh <service-id>
#
# Valid service IDs: rt-bus, agents, crew-lead, telegram, whatsapp, opencode, mcp, dashboard
#
# Dashboard uses direct restart (not API) to avoid race condition

set -euo pipefail

SERVICE_ID="${1:-}"
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:4319}"
CREWSWARM_DIR="${CREWSWARM_DIR:-$HOME/Desktop/CrewSwarm}"

if [[ -z "$SERVICE_ID" ]]; then
  echo "Usage: $0 <service-id>"
  echo "Valid IDs: rt-bus, agents, crew-lead, telegram, whatsapp, opencode, mcp, dashboard"
  exit 1
fi

# Dashboard special case - direct restart to avoid race condition
if [[ "$SERVICE_ID" == "dashboard" ]]; then
  echo "Restarting dashboard (direct)..."
  pkill -9 -f "scripts/dashboard.mjs" 2>/dev/null || true
  sleep 2
  nohup node "$CREWSWARM_DIR/scripts/dashboard.mjs" >> /tmp/dashboard.log 2>&1 &
  echo "✅ Dashboard restarted"
  exit 0
fi

# Check if dashboard is running for API calls
if ! curl -s -f "${DASHBOARD_URL}/api/health" >/dev/null 2>&1; then
  echo "Error: Dashboard not responding at ${DASHBOARD_URL}"
  echo "Start dashboard first: node scripts/dashboard.mjs"
  exit 1
fi

# Call the REST API with validation
RESPONSE=$(curl -s -X POST "${DASHBOARD_URL}/api/services/restart" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${SERVICE_ID}\"}" 2>&1)

# Check response
if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "✅ ${SERVICE_ID} restarted successfully"
  exit 0
elif echo "$RESPONSE" | grep -q '"ok":false'; then
  ERROR=$(echo "$RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
  echo "❌ Failed to restart ${SERVICE_ID}: ${ERROR}"
  exit 1
else
  echo "⚠️ Unexpected response: ${RESPONSE}"
  exit 1
fi
