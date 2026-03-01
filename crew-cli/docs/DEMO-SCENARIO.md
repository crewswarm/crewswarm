# crew-cli Deterministic Demo Scenario

Follow these steps to produce a consistent and impressive demo of `crew-cli` capabilities.

---

## Prerequisites
1. `crew-cli` installed and built.
2. CrewSwarm gateway running on port 5010.
3. A test repository (e.g., a simple Express app).

---

## Scenario: Refactoring a Data Layer

### Step 1: Explore Strategies
Run the automated speculative execution command.
```bash
crew explore "convert src/db.js from local storage to sqlite3"
```
**Expected Output:**
- `[INFO] 🔀 Exploring 3 approaches...`
- `✓ Completed explore-minimal`
- `✓ Completed explore-clean`
- `✓ Completed explore-pragmatic`

### Step 2: Compare & Select
Preview the "Clean" implementation.
```bash
crew preview explore-clean
```
**Expected Output:**
- Unified diff showing new `sqlite3` imports and structured DAO patterns.

Merge the winner.
```bash
# Interactively select explore-clean in the terminal or run:
crew merge explore-clean main
```

### Step 3: Verify with LSP
Check for type errors introduced by the refactor.
```bash
crew lsp check src/db.js
```
**Expected Output:**
- `[SUCCESS] No type errors found.` (or a fixable warning).

### Step 4: Parallel Plan Execution
Add new endpoints using the worker pool.
```bash
crew plan "add CRUD endpoints for 'products' and 'orders' using the new SQLite layer" --parallel --concurrency 2
```
**Expected Output:**
- `[INFO] Generating plan...`
- `[WorkerPool] Starting task: products-api`
- `[WorkerPool] Starting task: orders-api`
- `[SUCCESS] Parallel execution complete: 2 succeeded.`

### Step 5: Safety Gate (Blast Radius)
Analyze the impact of the changes.
```bash
crew blast-radius
```
**Expected Output:**
- `Risk Score: MEDIUM`
- `Affected Files: 5`
- `Impact: High dependency overlap in src/server.js`

### Step 6: Final Apply with Auto-Fix
Apply changes and run tests.
```bash
crew apply --check "npm test"
```
**Expected Output:**
- `[INFO] Running check: npm test`
- `[ERROR] Check failed: ReferenceError: sqlite is not defined`
- `[INFO] Attempting auto-fix by dispatching to crew-fixer...`
- `✓ Auto-fix applied. Re-running check...`
- `[SUCCESS] Check passed!`
