#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/Desktop/CrewSwarm}"
SWARM_PLUGIN_DIR="${SWARM_PLUGIN_DIR:-$HOME/swarm/.opencode/plugin}"
CTL="$HOME/bin/openswitchctl"
OPENCLAW_APP_HREF="file:///Applications/OpenClaw.app"
LOG_DIR="$HOME/.opencrew/logs"
DASHBOARD_URL="http://127.0.0.1:4319"
ICONS_DIR="$OPENCLAW_DIR/website"

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

# ── Stack controls ──────────────────────────────────────────────────
echo "---"
echo "⚙️ Stack Controls"
echo "▶ Start   | bash='/bin/bash' param1='$CTL' param2=start terminal=false refresh=true"
echo "⏹ Stop    | bash='/bin/bash' param1='$CTL' param2=stop terminal=false refresh=true"
echo "↺ Restart | bash='/bin/bash' param1='$CTL' param2=restart terminal=false refresh=true"
echo "--↺ Restart RT Server   | bash='/bin/bash' param1='$CTL' param2=restart-rt terminal=false refresh=true"
echo "--↺ Restart OpenClaw GW | bash='/bin/bash' param1='$CTL' param2=restart-openclaw terminal=false refresh=true"
echo "--↺ Restart Agent Links | bash='/bin/bash' param1='$CTL' param2=restart-gateway terminal=false refresh=true"

# ── Crew — each agent listed once with status icon ──────────────────
echo "---"
echo "🤖 Crew (${AGENTS_FRAC}) | sfimage=person.3.sequence.fill"
for AGENT in "${AGENTS[@]}"; do
  [[ -z "$AGENT" ]] && continue
  if [[ "$STATE" =~ $AGENT:up ]]; then
    echo "🟢 $AGENT | bash='/bin/bash' param1='$CTL' param2=restart-agent param3='$AGENT' terminal=false refresh=true"
  else
    echo "🔴 $AGENT | bash='/bin/bash' param1='$CTL' param2=start-agent param3='$AGENT' terminal=false refresh=true"
  fi
done

# ── Services ─────────────────────────────────────────────────────────
# Helper: check if a port is listening
_port_up() { lsof -i ":$1" -sTCP:LISTEN -t &>/dev/null && echo "up" || echo "down"; }
# Helper: check if a process pattern is running
_proc_up() { pgrep -f "$1" &>/dev/null && echo "up" || echo "down"; }

SVC_RT="$RT_STATE"
SVC_GW="$(_port_up 18789)"
SVC_TG="$(_proc_up 'telegram-bridge.mjs')"
SVC_CL="$(_proc_up 'crew-lead.mjs')"
SVC_OC="$(_port_up 4096)"
SVC_DB="$(_port_up 4319)"

_svc_icon() { [[ "$1" == "up" ]] && echo "🟢" || echo "🔴"; }

echo "---"
echo "🔧 Services"

echo "--$(_svc_icon $SVC_RT) RT Message Bus | bash='/bin/bash' param1='$CTL' param2=restart-rt terminal=false refresh=true"
echo "--$(_svc_icon $SVC_GW) OpenClaw Gateway | bash='/bin/bash' param1='$CTL' param2=restart-openclaw terminal=false refresh=true"
echo "--$(_svc_icon $SVC_TG) Telegram Bridge | bash='$OPENCLAW_DIR/scripts/restart-service.sh' param1=telegram terminal=false refresh=true"
echo "--$(_svc_icon $SVC_CL) crew-lead | bash='$OPENCLAW_DIR/scripts/restart-service.sh' param1=crew-lead terminal=false refresh=true"
echo "--$(_svc_icon $SVC_OC) OpenCode Server | bash='$OPENCLAW_DIR/scripts/restart-service.sh' param1=opencode terminal=false refresh=true"
echo "--$(_svc_icon $SVC_DB) Dashboard | bash='$OPENCLAW_DIR/scripts/restart-service.sh' param1=dashboard terminal=false refresh=true"

# ── Quick links ──────────────────────────────────────────────────────
echo "---"
echo "🧠 Chat with crew-lead | bash='open' param1='-a' param2='$HOME/Applications/CrewChat.app' terminal=false refresh=false"
echo "🖥️  Open Dashboard      | href='$DASHBOARD_URL/#chat'"
echo "🦞 Open OpenClaw App   | href='$OPENCLAW_APP_HREF'"

# ── Logs ─────────────────────────────────────────────────────────────
echo "---"
echo "🔧 Logs"
echo "RT Log        | bash='open' param1='$LOG_DIR/opencrew-rt.log' terminal=false"
echo "Crew Main Log | bash='open' param1='$LOG_DIR/openclaw-rt-crew-main.log' terminal=false"
echo "Plugin Dir    | bash='open' param1='$SWARM_PLUGIN_DIR' terminal=false"
echo "OpenClaw Dir  | bash='open' param1='$OPENCLAW_DIR' terminal=false"
