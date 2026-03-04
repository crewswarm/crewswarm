#!/usr/bin/env bash
# Test what happens when crew-lead is restarted via dashboard button
# This simulates the exact commands the dashboard runs

echo "═══════════════════════════════════════════════════════════"
echo "Testing crew-lead restart behavior (dashboard simulation)"
echo "═══════════════════════════════════════════════════════════"
echo ""

echo "Step 1: Current state BEFORE restart"
echo "────────────────────────────────────────────────────────────"
echo "crew-lead:  $(pgrep -f 'crew-lead.mjs' | wc -l | tr -d ' ') processes"
echo "dashboard:  $(pgrep -f 'dashboard.mjs' | wc -l | tr -d ' ') processes"
echo "whatsapp:   $(pgrep -f 'whatsapp-bridge.mjs' | wc -l | tr -d ' ') processes"
echo ""

ps aux | grep -E "(crew-lead|dashboard|whatsapp)" | grep node | grep -v grep

echo ""
echo "Step 2: Simulating dashboard restart command for crew-lead"
echo "────────────────────────────────────────────────────────────"
echo "Running: pkill -9 -f 'crew-lead.mjs'"

# This is the EXACT command from dashboard.mjs line 3412
pkill -9 -f "crew-lead.mjs" 2>/dev/null || echo "(no crew-lead processes found)"

echo "Running: lsof -ti :5010 | xargs kill -9"
lsof -ti :5010 2>/dev/null | xargs kill -9 2>/dev/null || echo "(port 5010 not in use)"

echo ""
echo "Waiting 2 seconds..."
sleep 2

echo ""
echo "Step 3: State AFTER killing crew-lead"
echo "────────────────────────────────────────────────────────────"
echo "crew-lead:  $(pgrep -f 'crew-lead.mjs' | wc -l | tr -d ' ') processes"
echo "dashboard:  $(pgrep -f 'dashboard.mjs' | wc -l | tr -d ' ') processes"
echo "whatsapp:   $(pgrep -f 'whatsapp-bridge.mjs' | wc -l | tr -d ' ') processes"
echo ""

if pgrep -f 'dashboard.mjs' >/dev/null; then
  echo "✅ Dashboard is STILL RUNNING (as expected)"
else
  echo "❌ Dashboard DIED (unexpected - this is the bug!)"
fi

if pgrep -f 'whatsapp-bridge.mjs' >/dev/null; then
  echo "✅ WhatsApp is STILL RUNNING (as expected)"
else
  echo "❌ WhatsApp DIED (unexpected - this is the bug!)"
fi

echo ""
echo "Step 4: Restarting crew-lead (dashboard would spawn it now)"
echo "────────────────────────────────────────────────────────────"
echo "Running: nohup node crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &"

cd /Users/jeffhobbs/Desktop/CrewSwarm
nohup node crew-lead.mjs >> /tmp/crew-lead.log 2>&1 &

sleep 2

echo ""
echo "Step 5: Final state AFTER restart"
echo "────────────────────────────────────────────────────────────"
echo "crew-lead:  $(pgrep -f 'crew-lead.mjs' | wc -l | tr -d ' ') processes"
echo "dashboard:  $(pgrep -f 'dashboard.mjs' | wc -l | tr -d ' ') processes"
echo "whatsapp:   $(pgrep -f 'whatsapp-bridge.mjs' | wc -l | tr -d ' ') processes"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "Test complete. All three should still be running."
echo "═══════════════════════════════════════════════════════════"
