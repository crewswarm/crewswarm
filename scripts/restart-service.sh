#!/usr/bin/env bash
# Restart a named CrewSwarm service
SERVICE="$1"
DIR="$HOME/Desktop/CrewSwarm"
OPENCLAW_CFG="$HOME/.openclaw/openclaw.json"

RT_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$OPENCLAW_CFG','utf8'));console.log(c.env?.OPENCREW_RT_AUTH_TOKEN||'')}catch{}" 2>/dev/null)
ALLOWED="main,admin,build,coder,researcher,architect,reviewer,qa,fixer,pm,orchestrator,openclaw,openclaw-main,opencode-pm,opencode-qa,opencode-fixer,opencode-coder,opencode-coder-2,security,crew-main,crew-pm,crew-qa,crew-fixer,crew-coder,crew-coder-2,crew-coder-front,crew-coder-back,crew-github,crew-security,crew-frontend,crew-copywriter,crew-telegram,crew-lead"

case "$SERVICE" in
  telegram)
    pkill -f "telegram-bridge.mjs" 2>/dev/null; sleep 1
    nohup node "$DIR/telegram-bridge.mjs" >> /tmp/telegram-bridge.log 2>&1 &
    ;;
  crew-lead)
    pkill -f "crew-lead.mjs" 2>/dev/null; sleep 1
    nohup node "$DIR/crew-lead.mjs" >> /tmp/crew-lead.log 2>&1 &
    ;;
  opencode)
    pkill -f "opencode serve" 2>/dev/null; sleep 1
    nohup opencode serve >> /tmp/opencode.log 2>&1 &
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
