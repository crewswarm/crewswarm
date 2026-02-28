# Hermetic Test Mode

## Overview
CrewSwarm now supports **hermetic testing** to prevent tests from interfering with your real `~/.crewswarm` configuration and state.

## What Was Fixed

### Issue #1: Non-Hermetic Tests (High Priority) ✅ FIXED
**Problem**: Tests wrote to real `~/.crewswarm` paths, causing:
- Flaky tests (permission issues)
- State pollution between test runs  
- Risk of corrupting real config during testing
- Inability to run tests in parallel

**Solution**: Added `CREWSWARM_TEST_MODE` environment variable that redirects all state paths to temporary directories.

### Issue #2: PM Stop-File Path Mismatch (High Priority) ✅ FIXED
**Problem**: Runtime used `./orchestrator-logs/PM.STOP`, test used `~/.crewswarm/orchestrator-logs/PM.STOP`.

**Solution**: Updated test to use repo-local path matching runtime behavior.

## How It Works

### New Path Resolution Module
**`lib/runtime/paths.mjs`** provides centralized path management:

```javascript
import { getConfigPath, getStatePath } from "./lib/runtime/paths.mjs";

// Get ~/.crewswarm/crewswarm.json (or temp dir in test mode)
const configFile = getConfigPath("crewswarm.json");

// Get ~/.crewswarm/chat-history (or temp dir in test mode)
const historyDir = getStatePath("chat-history");
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CREWSWARM_TEST_MODE` | Enable hermetic testing | `false` |
| `CREWSWARM_CONFIG_DIR` | Override config directory | `~/.crewswarm` |
| `CREWSWARM_STATE_DIR` | Override state directory | `~/.crewswarm` |

### Test Helper
**`test/helpers/hermetic.mjs`** simplifies hermetic test setup:

```javascript
import { setupHermeticTest, generateTestSessionId } from "../helpers/hermetic.mjs";

before(() => setupHermeticTest());

const testSession = generateTestSessionId("my-test");
```

## Updated Modules

### Core Modules
- ✅ `lib/chat/history.mjs` - Chat history storage
- ✅ `lib/runtime/spending.mjs` - Token usage and cost tracking
- ✅ `lib/crew-lead/wave-dispatcher.mjs` - Pipeline state

### Test Files
- ✅ `test/integration/chat-history.test.mjs`
- ✅ `test/integration/spending.test.mjs`
- ✅ `test/integration/pm-loop-flow.test.mjs`
- ✅ `test/unit/wave-dispatcher.test.mjs`

## Running Tests

### Normal Mode (Uses Real ~/.crewswarm)
```bash
npm test
```

### Hermetic Mode (Uses Temp Directories)
```bash
CREWSWARM_TEST_MODE=true npm test
```

### Individual Test with Hermetic Mode
```bash
CREWSWARM_TEST_MODE=true node --test test/integration/spending.test.mjs
```

## Benefits

1. **Parallel Testing**: Tests no longer conflict over shared files
2. **CI Reliability**: No permission issues or state pollution
3. **Safe Development**: Your real config is never touched during testing
4. **Faster Tests**: Temp directories are cleaned up automatically

## Migration Guide

If you're writing new tests that need config/state access:

### Before (Non-Hermetic)
```javascript
const HISTORY_DIR = path.join(os.homedir(), ".crewswarm", "chat-history");

before(() => {
  // Save real file
  savedData = fs.readFileSync(HISTORY_DIR + "/test.jsonl");
});

after(() => {
  // Restore real file
  fs.writeFileSync(HISTORY_DIR + "/test.jsonl", savedData);
});
```

### After (Hermetic)
```javascript
import { setupHermeticTest } from "../helpers/hermetic.mjs";
import { getStatePath } from "../../lib/runtime/paths.mjs";

before(() => setupHermeticTest());

// Automatically uses temp dir in test mode
const historyDir = getStatePath("chat-history");
```

## Future Work

Other modules that could benefit from hermetic mode (not critical):
- `lib/runtime/telemetry.mjs` (telemetry events)
- `lib/crew-lead/brain.mjs` (brain.md persistence)
- Test cleanup for `orchestrator-logs/` directory

## Testing the Fix

Run the updated tests:
```bash
# Test chat history (hermetic)
CREWSWARM_TEST_MODE=true node --test test/integration/chat-history.test.mjs

# Test spending (hermetic)
CREWSWARM_TEST_MODE=true node --test test/integration/spending.test.mjs

# Test PM loop (stop file path fix)
CREWSWARM_TEST_MODE=true node --test test/integration/pm-loop-flow.test.mjs
```

All tests should pass without touching your real `~/.crewswarm` directory! 🎉
