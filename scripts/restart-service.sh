#!/usr/bin/env bash
# Restart a named CrewSwarm service (use repo when run from repo)
SERVICE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${OPENCLAW_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CREW_CFG="$HOME/.crewswarm/config.json"
OPENCLAW_CFG="$HOME/.openclaw/openclaw.json"
# Token: crewswarm config first (dashboard saves here), then openclaw
RT_TOKEN=$(node -e "
try {
  const fs=require('fs');
  const c=fs.existsSync('$CREW_CFG') ? JSON.parse(fs.readFileSync('$CREW_CFG','utf8')) : {};
  if(c?.rt?.authToken){ console.log(c.rt.authToken); process.exit(0); }
  const o=JSON.parse(fs.readFileSync('$OPENCLAW_CFG','utf8'));
  console.log(o?.env?.OPENCREW_RT_AUTH_TOKEN||'');
} catch {}
" 2>/dev/null)
ALLOWED="main,admin,build,coder,researcher,architect,reviewer,qa,fixer,pm,orchestrator,openclaw,openclaw-main,opencode-pm,opencode-qa,opencode-fixer,opencode-coder,opencode-coder-2,security,crew-main,crew-pm,crew-qa,crew-fixer,crew-coder,crew-coder-2,crew-coder-front,crew-coder-back,crew-github,crew-security,crew-frontend,crew-copywriter,crew-telegram,crew-lead"

  case "$SERVICE" in
  telegram)
    pkill -f "telegram-bridge.mjs" 2>/dev/null; sleep 1
    nohup node "$DIR/telegram-bridge.mjs" >> /tmp/telegram-bridge.log 2>&1 &
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
  dashboard)
    pkill -f "scripts/dashboard.mjs" 2>/dev/null; sleep 1
    nohup node "$DIR/scripts/dashboard.mjs" >> /tmp/dashboard.log 2>&1 &
    ;;
  *)
    echo "Unknown service: $SERVICE"
    exit 1
    ;;
esac
