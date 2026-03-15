#!/bin/bash

# Test that standalone mode executes L3 workers instead of dispatching to crew-main

cd "$(dirname "$0")"

echo "Testing L3 execution in standalone mode..."
echo ""

# Make sure we're in standalone mode
export CREW_INTERFACE_MODE=standalone

# Run a simple coding task that should execute at L3
node bin/crew.js chat "create a hello.js file that exports a greet function" 2>&1 | tee /tmp/crew-l3-test.log

# Check the output for signs of L3 execution
if grep -q "L3 Execute" /tmp/crew-l3-test.log || grep -q "unified-pipeline" /tmp/crew-l3-test.log; then
  echo ""
  echo "✅ SUCCESS: L3 execution detected"
  exit 0
elif grep -q "crew-main" /tmp/crew-l3-test.log; then
  echo ""
  echo "❌ FAIL: Still routing to crew-main instead of L3"
  exit 1
else
  echo ""
  echo "⚠️  UNCLEAR: Check /tmp/crew-l3-test.log for details"
  exit 2
fi
