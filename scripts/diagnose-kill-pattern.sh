#!/usr/bin/env bash
# Diagnostic: Shows what different kill patterns would affect
# Usage: bash scripts/diagnose-kill-pattern.sh [pattern]

PATTERN="${1:-crew-lead}"

echo "═══════════════════════════════════════════════════════════"
echo "Testing kill pattern: '$PATTERN'"
echo "═══════════════════════════════════════════════════════════"
echo ""

echo "Processes that would be killed by: pkill -f '$PATTERN'"
echo "───────────────────────────────────────────────────────────"

PIDS=$(pgrep -f "$PATTERN" 2>/dev/null)

if [ -z "$PIDS" ]; then
  echo "  (none)"
else
  echo "$PIDS" | while read -r pid; do
    ps -p "$pid" -o pid,ppid,pgid,command 2>/dev/null | tail -n +2
  done
fi

echo ""
echo "Summary:"
echo "  Processes matched: $(echo "$PIDS" | wc -w | tr -d ' ')"
echo ""

# Check if critical services would be affected
CREW_LEAD=$(echo "$PIDS" | xargs -I {} ps -p {} -o command= 2>/dev/null | grep -c "crew-lead.mjs")
DASHBOARD=$(echo "$PIDS" | xargs -I {} ps -p {} -o command= 2>/dev/null | grep -c "dashboard.mjs")
WHATSAPP=$(echo "$PIDS" | xargs -I {} ps -p {} -o command= 2>/dev/null | grep -c "whatsapp-bridge.mjs")
TELEGRAM=$(echo "$PIDS" | xargs -I {} ps -p {} -o command= 2>/dev/null | grep -c "telegram-bridge.mjs")
BRIDGES=$(echo "$PIDS" | xargs -I {} ps -p {} -o command= 2>/dev/null | grep -c "gateway-bridge.mjs")

echo "Critical services that would be killed:"
echo "  crew-lead:  $CREW_LEAD"
echo "  dashboard:  $DASHBOARD"
echo "  whatsapp:   $WHATSAPP"
echo "  telegram:   $TELEGRAM"
echo "  bridges:    $BRIDGES"
echo ""

if [ "$CREW_LEAD" -eq 1 ] && [ "$DASHBOARD" -eq 0 ] && [ "$WHATSAPP" -eq 0 ]; then
  echo "✅ SAFE: Only crew-lead would be killed"
elif [ "$CREW_LEAD" -eq 1 ] && [ "$DASHBOARD" -gt 0 ]; then
  echo "⚠️  WARNING: crew-lead AND dashboard would be killed!"
elif [ "$CREW_LEAD" -eq 0 ]; then
  echo "⚠️  WARNING: crew-lead would NOT be killed!"
else
  echo "⚠️  WARNING: Multiple services would be killed!"
fi

echo ""
echo "Recommended patterns:"
echo "  pkill -f 'crew-lead.mjs'     → Only crew-lead"
echo "  pkill -f 'dashboard.mjs'     → Only dashboard"
echo "  pkill -f 'whatsapp-bridge'   → Only WhatsApp"
echo "  pkill -f 'gateway-bridge'    → All agent bridges"
echo ""
