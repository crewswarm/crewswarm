#!/usr/bin/env bash
# Restart a named CrewSwarm service (telegram, crew-lead, opencode, dashboard). Used by SwiftBar.
SERVICE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${CREWSWARM_DIR:-${OPENCLAW_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}}"

# Use launchctl for services that have LaunchAgents — avoids the KeepAlive race condition
# where launchd and a manual nohup both try to bind the same port.
_launchctl_restart() {
  local label="$1"
  if launchctl list "$label" >/dev/null 2>&1; then
    launchctl stop "$label" 2>/dev/null; sleep 1
    launchctl start "$label" 2>/dev/null
    return 0
  fi
  return 1  # no LaunchAgent — caller falls back to nohup
}

case "$SERVICE" in
  telegram)
    _launchctl_restart com.crewswarm.telegram || {
      pkill -f "telegram-bridge.mjs" 2>/dev/null; sleep 1
      nohup node "$DIR/telegram-bridge.mjs" >> /tmp/telegram-bridge.log 2>&1 &
    }
    ;;
  whatsapp)
    _launchctl_restart com.crewswarm.whatsapp || {
      pkill -f "whatsapp-bridge.mjs" 2>/dev/null; sleep 1
      nohup node "$DIR/whatsapp-bridge.mjs" >> /tmp/whatsapp-bridge.log 2>&1 &
    }
    ;;
  dashboard)
    _launchctl_restart com.crewswarm.dashboard || {
      pkill -f "scripts/dashboard.mjs" 2>/dev/null; sleep 1
      nohup node "$DIR/scripts/dashboard.mjs" >> /tmp/dashboard.log 2>&1 &
    }
    ;;
  crew-lead)
    pkill -f "crew-lead.mjs" 2>/dev/null; sleep 1
    (cd "$DIR" && nohup node crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &)
    ;;
  opencode)
    pkill -f "opencode serve" 2>/dev/null; sleep 1
    export PATH="$HOME/bin:${PATH:-/usr/bin:/bin}"
    OPENCODE_BIN=""
    command -v opencode &>/dev/null && OPENCODE_BIN="opencode"
    [[ -z "$OPENCODE_BIN" ]] && [[ -x /usr/local/bin/opencode ]] && OPENCODE_BIN="/usr/local/bin/opencode"
    [[ -z "$OPENCODE_BIN" ]] && OPENCODE_BIN="opencode"
    nohup $OPENCODE_BIN serve --port 4096 --hostname 127.0.0.1 >> /tmp/opencode.log 2>&1 &
    ;;
  mcp)
    pkill -f "mcp-server.mjs" 2>/dev/null
    lsof -ti :5020 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
    nohup node "$DIR/scripts/mcp-server.mjs" >> /tmp/crewswarm-mcp.log 2>&1 &
    ;;
  *)
    echo "Unknown service: $SERVICE"
    exit 1
    ;;
esac
