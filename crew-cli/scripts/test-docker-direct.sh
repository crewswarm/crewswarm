#!/usr/bin/env bash
set -e

echo ""
echo "🧪 Docker Sandbox Direct Test"
echo "════════════════════════════════"
echo ""

# Setup test project
TEST_DIR="/tmp/crew-docker-sandbox-direct-$(date +%s)"
mkdir -p "$TEST_DIR/tests" "$TEST_DIR/src" "$TEST_DIR/.crew"

cd "$TEST_DIR"

# Create package.json
cat > package.json << 'EOF'
{
  "name": "docker-sandbox-test",
  "type": "module"
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

echo "✅ Step 1: Created project with BROKEN implementation"
echo "   File: src/math.js contains 'return 0'"
echo ""

# Test with native execution (should FAIL)
echo "✅ Step 2: Native test (no Docker, no staging)"
echo ""
if node --test tests/ 2>&1 | grep -q "✖"; then
  echo "   Result: FAILED ✓ (expected - broken code)"
else
  echo "   Result: PASSED ✗ (unexpected!)"
  exit 1
fi

echo ""
echo "✅ Step 3: Stage FIXED code in sandbox"
echo ""

# Create sandbox.json with staged FIXED code
cat > .crew/sandbox.json << 'EOF'
{
  "activeBranch": "main",
  "branches": {
    "main": {
      "src/math.js": {
        "type": "file",
        "modified": "export function add(a, b) {\n  return a + b; // FIXED - correct implementation\n}\n"
      }
    }
  }
}
EOF

echo "   Sandbox staged: src/math.js with 'return a + b'"
echo "   Disk still has: 'return 0' (unchanged)"
echo ""

# Now test with Docker using crew-cli's tool executor
echo "✅ Step 4: Run test with Docker sandbox (staged files)"
echo ""

cd /Users/jeffhobbs/CrewSwarm/crew-cli

# Create a minimal test that uses the Docker sandbox
node << 'NODEEOF'
import { Sandbox } from './dist/crew.mjs';
import { DockerSandbox } from './dist/crew.mjs';

const TEST_DIR = process.argv[1];
const sandbox = new Sandbox(`${TEST_DIR}/.crew`);
await sandbox.init();

const docker = new DockerSandbox();
const isAvailable = await docker.isDockerAvailable();

if (!isAvailable) {
  console.log('   ❌ Docker not available');
  process.exit(1);
}

await docker.ensureImage();

console.log('   Docker ready, running tests...');

const result = await docker.runCommand(
  'node --test tests/',
  sandbox,
  { workDir: TEST_DIR, timeout: 30000 }
);

console.log('');
if (result.success) {
  console.log('   Result: PASSED ✓ (staged FIXED code in Docker)');
  console.log('');
  console.log('🎉 Docker Sandbox Test PASSED!');
  console.log('');
  console.log('Proof:');
  console.log('  1. Disk has BROKEN code → native test fails');
  console.log('  2. Sandbox has FIXED code → Docker test passes');
  console.log('  3. Perfect isolation - test before commit works!');
  process.exit(0);
} else {
  console.log('   Result: FAILED ✗');
  console.log('   Output:', result.output.slice(0, 500));
  process.exit(1);
}
NODEEOF "$TEST_DIR"

EXIT_CODE=$?

# Verify disk is still broken
echo ""
echo "✅ Step 5: Verify isolation"
echo ""
if grep -q "return 0" "$TEST_DIR/src/math.js"; then
  echo "   Disk file: STILL BROKEN ✓ (unchanged)"
else
  echo "   Disk file: MODIFIED ✗ (isolation failed!)"
  exit 1
fi

# Cleanup
rm -rf "$TEST_DIR"

exit $EXIT_CODE
