#!/usr/bin/env bash
set -euo pipefail

CREWSWARM_DIR="${CREWSWARM_DIR:-${OPENCLAW_DIR:-$HOME/Desktop/CrewSwarm}}"
SWARM_PLUGIN_DIR="${SWARM_PLUGIN_DIR:-$HOME/swarm/.opencode/plugin}"
# Prefer repo script so SwiftBar works without installing to ~/bin
if [[ -x "$CREWSWARM_DIR/scripts/openswitchctl" ]]; then
  CTL="$CREWSWARM_DIR/scripts/openswitchctl"
else
  CTL="$HOME/bin/openswitchctl"
fi
LOG_DIR="/tmp"
DASHBOARD_URL="http://127.0.0.1:4319"
ICONS_DIR="$CREWSWARM_DIR/website"

# Status colors — only used on icon lines and status info rows
STATUS_GREEN="#28a745"
STATUS_RED="#dc3545"

# Load mascot icons as base64 — 22px for menu bar (renders at 22pt = correct height)
_icon() { base64 -i "$ICONS_DIR/$1" 2>/dev/null | tr -d '\n'; }
ICON_DEFAULT=$(_icon "opencrewhq_swiftbar_alien_22.png")
ICON_RUNNING=$(_icon "opencrewhq_swiftbar_alien_22_running.png")
ICON_SUCCESS=$(_icon "opencrewhq_swiftbar_alien_22_success.png")
ICON_ERROR=$(_icon  "opencrewhq_swiftbar_alien_22_error.png")
ICON_WARNING=$(_icon "opencrewhq_swiftbar_alien_22_warning.png")

# Fallback to SF symbol if icons not found
if [[ -z "$ICON_DEFAULT" ]]; then
  ICON_FALLBACK=1
else
  ICON_FALLBACK=0
fi

if [[ ! -x "$CTL" ]]; then
  if [[ "$ICON_FALLBACK" -eq 0 ]]; then
    echo "| image=$ICON_ERROR"
  else
    echo "| sfimage=exclamationmark.triangle.fill color=$STATUS_RED"
  fi
  echo "---"
  echo "Missing: $CTL | sfimage=exclamationmark.triangle"
  exit 0
fi

STATE="$(/bin/bash "$CTL" status || true)"
RT_STATE="down"
CLAW_STATE="down"
AGENTS_FRAC="0/0"
[[ "$STATE" =~ rt:up ]] && RT_STATE="up"
if [[ "$STATE" =~ agents:([0-9]+/[0-9]+) ]]; then
  AGENTS_FRAC="${BASH_REMATCH[1]}"
fi
if [[ "$STATE" =~ crew-main:up ]]; then
  CLAW_STATE="up"
fi

# Service status (same source as Services section — used for Crew list too)
_port_up() { lsof -i ":$1" -sTCP:LISTEN -t &>/dev/null && echo "up" || echo "down"; }
_proc_up() { pgrep -f "$1" &>/dev/null && echo "up" || echo "down"; }
SVC_RT="$RT_STATE"
SVC_AG="$(_proc_up 'gateway-bridge.mjs')"
SVC_TG="$(_proc_up 'telegram-bridge.mjs')"
SVC_WA="$(_proc_up 'whatsapp-bridge.mjs')"
SVC_CL="$(_proc_up 'crew-lead.mjs')"
SVC_OC="$(_port_up 4096)"
SVC_DB="$(_port_up 4319)"
SVC_MCP="$(_port_up 5020)"
SVC_CM="$(_port_up 8000)"

# Get dynamic agent list
AGENTS=()
while IFS= read -r line; do
  AGENTS+=("$line")
done < <("$CTL" agents 2>/dev/null || echo "crew-main")

# ── Menu bar icon — mascot with status dot, fallback to SF symbol ──
if [[ "$ICON_FALLBACK" -eq 0 ]]; then
  if [[ "$STATE" == running* ]]; then
    echo "| image=$ICON_RUNNING"
  else
    echo "| image=$ICON_ERROR"
  fi
else
  if [[ "$STATE" == running* ]]; then
    echo "| sfimage=bolt.horizontal.fill color=$STATUS_GREEN"
  else
    echo "| sfimage=bolt.badge.xmark color=$STATUS_RED"
  fi
fi

# ── Primary action — chat first ─────────────────────────────────────
echo "---"
echo "💬 Open Chat | href='${DASHBOARD_URL}/#chat' color=#38bdf8"
echo "🖥️  Open Dashboard | href='$DASHBOARD_URL'"
echo "---"
echo "⚙️ Stack Controls"
echo "▶ Start   | bash='/bin/bash' param1='$CTL' param2=start terminal=false refresh=true"
echo "⏹ Stop    | bash='/bin/bash' param1='$CTL' param2=stop terminal=false refresh=true"
echo "↺ Restart | bash='/bin/bash' param1='$CTL' param2=restart terminal=false refresh=true"
echo "--↺ Restart RT Server   | bash='/bin/bash' param1='$CTL' param2=restart-rt terminal=false refresh=true"
echo "--↺ Restart Agent Bridges | bash='/bin/bash' param1='$CTL' param2=restart-gateway terminal=false refresh=true"

# Per-agent status: use same source as Services — crew-lead from SVC_CL, bridge agents from STATE
_agent_up() {
  local a="$1"
  [[ -z "$a" ]] && return 1
  if [[ "$a" == "crew-lead" ]]; then
    [[ "$SVC_CL" == "up" ]] && return 0 || return 1
  fi
  # Word-boundary match so "main" doesn't match inside "crew-main:up"
  [[ "$STATE" =~ (^|[[:space:]])${a}:up($|[[:space:]]) ]] && return 0 || return 1
}

# ── Crew — each agent listed once with status icon ──────────────────
echo "---"
echo "🤖 Crew (${AGENTS_FRAC}) | sfimage=person.3.sequence.fill"
for AGENT in "${AGENTS[@]}"; do
  [[ -z "$AGENT" ]] && continue
  if _agent_up "$AGENT"; then
    echo "🟢 $AGENT | bash='/bin/bash' param1='$CTL' param2=restart-agent param3='$AGENT' terminal=false refresh=true"
  else
    echo "🔴 $AGENT | bash='/bin/bash' param1='$CTL' param2=start-agent param3='$AGENT' terminal=false refresh=true"
  fi
done

# ── Services ─────────────────────────────────────────────────────────
_svc_icon() { [[ "$1" == "up" ]] && echo "🟢" || echo "🔴"; }

echo "---"
echo "🔧 Services"

echo "--$(_svc_icon $SVC_RT) RT Message Bus          | bash='/bin/bash' param1='$CTL' param2=restart-rt terminal=false refresh=true"
echo "--$(_svc_icon $SVC_AG) Agent Bridges (${AGENTS_FRAC}) | bash='/bin/bash' param1='$CTL' param2=restart-gateway terminal=false refresh=true"
for AGENT in "${AGENTS[@]}"; do
  [[ -z "$AGENT" ]] && continue
  if _agent_up "$AGENT"; then
    echo "----🟢 $AGENT | bash='/bin/bash' param1='$CTL' param2=restart-agent param3='$AGENT' terminal=false refresh=true"
  else
    echo "----🔴 $AGENT | bash='/bin/bash' param1='$CTL' param2=start-agent param3='$AGENT' terminal=false refresh=true"
  fi
done
echo "--$(_svc_icon $SVC_TG) Telegram Bridge         | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=telegram terminal=false refresh=true"
echo "--$(_svc_icon $SVC_WA) WhatsApp Bridge         | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=whatsapp terminal=false refresh=true"
echo "--$(_svc_icon $SVC_CL) crew-lead               | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=crew-lead terminal=false refresh=true"
echo "--$(_svc_icon $SVC_OC) Code Engine             | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=opencode terminal=false refresh=true"
echo "--$(_svc_icon $SVC_MCP) MCP + OpenAI API        | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=mcp terminal=false refresh=true"
echo "--$(_svc_icon $SVC_DB) Dashboard               | bash='$CREWSWARM_DIR/scripts/restart-service.sh' param1=dashboard terminal=false refresh=true"
if [[ "$SVC_CM" == "up" ]]; then
  echo "--🟢 ChatMock (port 8000) | bash='/bin/bash' param1='-c' param2='pkill -f chatmock.py' terminal=false refresh=true"
else
  echo "--🔴 ChatMock             | bash='osascript' param1='-e' param2='tell app \"Terminal\" to do script \"cd $CREWSWARM_DIR && bash scripts/chatmock-serve.sh\"' terminal=false refresh=true"
fi

# ── Quick links ──────────────────────────────────────────────────────
echo "---"
echo "📁 Open CrewSwarm Repo | bash='open' param1='$CREWSWARM_DIR' terminal=false refresh=false"

# ── Logs ─────────────────────────────────────────────────────────────
echo "---"
echo "🔧 Logs"
echo "RT Log           | bash='open' param1='$LOG_DIR/opencrew-rt-daemon.log' terminal=false"
echo "crew-lead Log    | bash='open' param1='$LOG_DIR/crew-lead.log' terminal=false"
echo "Dashboard Log    | bash='open' param1='$LOG_DIR/dashboard.log' terminal=false"
echo "MCP Log          | bash='open' param1='$LOG_DIR/crewswarm-mcp.log' terminal=false"
echo "Telegram Log     | bash='open' param1='$LOG_DIR/telegram-bridge.log' terminal=false"
echo "WhatsApp Log     | bash='open' param1='$LOG_DIR/whatsapp-bridge.log' terminal=false"
echo "CrewSwarm Dir    | bash='open' param1='$CREWSWARM_DIR' terminal=false"
