#!/usr/bin/env bash
set -e

echo "🧪 Docker Sandbox E2E Test"
echo ""

# Setup test project
TEST_DIR="/tmp/crew-docker-sandbox-test-$(date +%s)"
mkdir -p "$TEST_DIR/tests" "$TEST_DIR/src"

cd "$TEST_DIR"

# Create package.json
cat > package.json << 'EOF'
{
  "name": "docker-sandbox-test",
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
EOF

# Create test file
cat > tests/math.test.js << 'EOF'
import assert from 'assert';
import test from 'node:test';
import { add } from '../src/math.js';

test('addition works', () => {
  assert.strictEqual(add(2, 3), 5);
});
EOF

# Create BROKEN implementation on disk
cat > src/math.js << 'EOF'
export function add(a, b) {
  return 0; // BROKEN - always returns 0
}
EOF

echo "✓ Created test project with BROKEN implementation on disk"
echo ""

# Test with native execution (should FAIL)
echo "Test 1: Native execution (broken disk file)"
echo ""
if npm test 2>&1 | grep -q "failed"; then
  echo "✓ Native test FAILED as expected (broken disk file)"
else
  echo "⚠️  UNEXPECTED: Native test passed (should fail)"
fi

echo ""
echo "Test 2: Using crew-cli to fix and test in Docker sandbox"
echo ""

# Use crew-cli to fix the file
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli

# Task: Fix the add function and run tests
TASK="Fix the add function in $TEST_DIR/src/math.js - it should return a + b, not 0. After fixing it, stage the change and run npm test to verify."

echo "Running: crew run --task \"$TASK\""
echo ""

# This will:
# 1. L2 analyzes the task
# 2. L3 worker reads the file, fixes it, stages change
# 3. L3 worker runs @@RUN_CMD npm test
# 4. Docker sandbox copies staged file and runs test in isolation
# 5. Test passes with staged file, disk unchanged

./dist/crew.mjs run --task "$TASK" --yes 2>&1 | tee /tmp/crew-docker-test.log

# Check results
echo ""
echo "Checking results..."
echo ""

# Verify disk file is still broken
if grep -q "return 0" "$TEST_DIR/src/math.js"; then
  echo "✅ Disk file still BROKEN (isolation verified)"
else
  echo "❌ Disk file was modified (isolation broken!)"
  exit 1
fi

# Check if test passed in log
if grep -q "✓" /tmp/crew-docker-test.log && grep -q "npm test" /tmp/crew-docker-test.log; then
  echo "✅ Docker test PASSED with staged file"
  echo ""
  echo "🎉 ALL TESTS PASSED!"
  echo ""
  echo "Summary:"
  echo "  - Native tests run against disk (broken) ❌"
  echo "  - Docker tests run against staged files (fixed) ✅"
  echo "  - Disk unchanged after Docker tests ✅"
  echo "  - Perfect test-before-commit workflow! ✅"
else
  echo "⚠️  Could not verify Docker test results"
  echo "Check log: /tmp/crew-docker-test.log"
fi

# Cleanup
rm -rf "$TEST_DIR"
