#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/Desktop/OpenClaw}"
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

# Runtime status — emoji color works in both dark and light mode without color= hacks
echo "---"
if [[ "$RT_STATE" == "up" ]]; then
  echo "🟢 RT Bus"
else
  echo "🔴 RT Bus"
fi
if [[ "$CLAW_STATE" == "up" ]]; then
  echo "🟢 OpenClaw Gateway"
else
  echo "🔴 OpenClaw Gateway"
fi

# ── Quick links ──────────────────────────────────────────────────────
echo "---"
echo "🖥️  Open Dashboard    | href='$DASHBOARD_URL'"
echo "📢 Broadcast to Crew | href='$DASHBOARD_URL?to=broadcast&focus=1'"
echo "🦞 Open OpenClaw App  | href='$OPENCLAW_APP_HREF'"

# ── Logs ─────────────────────────────────────────────────────────────
echo "---"
echo "🔧 Logs"
echo "RT Log        | bash='open' param1='$LOG_DIR/opencrew-rt.log' terminal=false"
echo "Crew Main Log | bash='open' param1='$LOG_DIR/openclaw-rt-crew-main.log' terminal=false"
echo "Plugin Dir    | bash='open' param1='$SWARM_PLUGIN_DIR' terminal=false"
echo "OpenClaw Dir  | bash='open' param1='$OPENCLAW_DIR' terminal=false"
