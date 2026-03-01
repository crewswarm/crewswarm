# User Approval & Interaction Flow

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ USER TYPES: "Build me an auth system with JWT and tests"       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L1: REPL receives input, creates request                        │
│     sessionId: abc123, context: current branch, files           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2: ROUTER classifies request                                   │
│     Decision: "execute-parallel" (complex task detected)        │
│     Estimated cost: $0.024                                      │
│     Complexity: high                                            │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ├─────→ IF cost > CREW_COST_LIMIT ($0.50)
                         │       ┌────────────────────────────────┐
                         │       │ GATE #1: COST APPROVAL         │
                         │       │                                │
                         │       │ ⚠️  Estimated cost: $0.024    │
                         │       │    Continue? (y/n):           │
                         │       │                                │
                         │       │ USER: y ← BLOCKS HERE         │
                         │       └────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2A: DECOMPOSER breaks down task                               │
│      Output: Work graph with 3 units                            │
│      ├─ auth-endpoints (crew-coder)                             │
│      ├─ jwt-validation (crew-coder)                             │
│      └─ tests (crew-qa)                                         │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2B: POLICY VALIDATOR checks risk                              │
│      Risk level: medium                                         │
│      Concerns:                                                  │
│      - Writes to src/auth/*.js                                  │
│      - Creates new test files                                   │
│      Approved: true                                             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ├─────→ IF risk === 'critical'
                         │       ┌────────────────────────────────┐
                         │       │ GATE #2: RISK APPROVAL         │
                         │       │                                │
                         │       │ ⚠️  CRITICAL RISK DETECTED    │
                         │       │    - Deletes files            │
                         │       │    - External API calls       │
                         │       │                                │
                         │       │ Proceed? (y/n):               │
                         │       │ USER: y ← BLOCKS HERE         │
                         │       └────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L3: PARALLEL EXECUTORS                                          │
│                                                                  │
│ Batch 1 (parallel):                                             │
│   ├─ [crew-coder] auth-endpoints                               │
│   └─ [crew-coder] jwt-validation                               │
│                                                                  │
│ Batch 2 (after Batch 1):                                        │
│   └─ [crew-qa] tests                                           │
│                                                                  │
│ All changes go to SANDBOX (not disk)                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2: SYNTHESIZE RESULTS                                          │
│     Combine all executor outputs                                │
│     Generate execution summary                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ L1: PRESENT TO USER                                             │
│                                                                  │
│ ✓ Auth system complete                                          │
│                                                                  │
│ Files changed (in sandbox):                                     │
│   + src/auth/endpoints.js                                       │
│   + src/auth/jwt.js                                             │
│   + tests/auth.test.js                                          │
│                                                                  │
│ Cost: $0.024 | Time: 18s                                        │
│ Path: l1 → l2 → l2a → l2b → l3 (3 executors)                   │
│                                                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ├─────→ GATE #3: FILE APPROVAL
                         │       ┌────────────────────────────────┐
                         │       │ USER COMMANDS:                 │
                         │       │                                │
                         │       │ /preview   ← Review changes    │
                         │       │ /apply     ← Write to disk    │
                         │       │ /rollback  ← Discard all      │
                         │       │                                │
                         │       │ USER: /preview ← BLOCKS HERE   │
                         │       └────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ SHOW DIFF:                                                       │
│                                                                  │
│ + src/auth/endpoints.js (234 lines)                             │
│   + export async function login(req, res) { ... }               │
│   + export async function register(req, res) { ... }            │
│                                                                  │
│ Commands: /apply | /rollback | /edit <file>                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ USER: /apply
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ WRITE TO DISK                                                    │
│                                                                  │
│ ✓ src/auth/endpoints.js                                         │
│ ✓ src/auth/jwt.js                                               │
│ ✓ tests/auth.test.js                                            │
│                                                                  │
│ All changes applied successfully                                │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ READY FOR NEXT COMMAND                                          │
│ crew(builder)>                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Three Approval Gates Explained

### Gate #1: Cost Approval (Configurable)
**When**: Before L2A planning (after routing decision)
**Trigger**: `estimatedCost > CREW_COST_LIMIT`
**Default**: `$0.50`

```bash
# Set your limit
export CREW_COST_LIMIT="0.25"

# Disable (allow any cost)
export CREW_COST_LIMIT="999.99"
```

**Example**:
```
⚠️  High cost task detected
   Estimated: $0.75
   Limit: $0.50
   
   Continue? (y/n): _
```

### Gate #2: Risk Approval (Always On for CRITICAL)
**When**: After L2B policy validation
**Trigger**: `riskLevel === 'critical'` OR `CREW_ALLOW_CRITICAL=false`
**Default**: Block all CRITICAL

```bash
# Allow critical risks (not recommended)
export CREW_ALLOW_CRITICAL="true"
```

**Example**:
```
⚠️  CRITICAL RISK DETECTED
   Concerns:
   - Deletes 15 production files
   - Makes external API call to payment processor
   - Modifies security settings
   
   Recommendations:
   - Review changes manually
   - Test in staging first
   - Create backup
   
   Proceed anyway? (y/n): _
```

### Gate #3: File Approval (Always On)
**When**: After L3 execution, before disk write
**Trigger**: Always (unless `CREW_AUTO_APPLY=true` in orchestrator mode)
**Default**: Require explicit `/apply`

```bash
# Auto-apply (orchestrator mode only)
export CREW_AUTO_APPLY="true"  # Still uses sandbox first
```

**Commands**:
```
/preview         # Show full diff
/preview <file>  # Show single file diff
/apply           # Write all to disk
/apply <file>    # Write single file
/rollback        # Discard all changes
/edit <file>     # Manual edit before apply
```

## Special Cases

### No Approval Needed (Direct Answer)
```
User: "What is JWT?"
  ↓
L2: direct-answer decision
  ↓
Response printed immediately
  ↓
DONE (no gates, cost ~$0.0001)
```

### Auto-Apply (Orchestrator Mode)
```
User: Sets mode to orchestrator
  ↓
All gates still check, but:
  - Gate #1: Warning only (proceeds)
  - Gate #2: Warning only (proceeds if not CRITICAL)
  - Gate #3: Auto-applies after showing changes
```

### Override All Gates (Expert Mode)
```bash
# Not recommended, but possible
export CREW_COST_LIMIT="999.99"
export CREW_ALLOW_CRITICAL="true"
export CREW_AUTO_APPLY="true"

# Now only explicit /approve prompts will block
```

## Trace Full Flow

Use `/trace` after any operation to see exact path:

```
crew(builder)> /trace

Trace ID: pipeline-abc123-def456

L1 → L2 Router
  Model: grok-beta
  Prompt: "router-v1 + task overlay"
  Decision: execute-parallel
  Cost: $0.0008 | Time: 1.8s

L2 → L2A Decomposer
  Model: deepseek-chat
  Prompt: "decomposer-v1 + work-graph overlay"
  Output: 3 work units, 2 batches
  Cost: $0.0031 | Time: 2.4s

L2A → L2B Validator
  Model: gemini-2.0-flash-exp
  Prompt: "validator-v1 + policy overlay"
  Risk: medium, Approved: true
  Cost: $0.0000 | Time: 1.9s

L2B → L3 Executors (Batch 1)
  [crew-coder] auth-endpoints
    Model: deepseek-chat
    Cost: $0.0087 | Time: 6.2s
  
  [crew-coder] jwt-validation  
    Model: deepseek-chat
    Cost: $0.0065 | Time: 5.1s

L3 Batch 1 → L3 Executors (Batch 2)
  [crew-qa] tests
    Model: gemini-2.0-flash-exp
    Cost: $0.0000 | Time: 4.8s

Total: $0.0191 | 22.2s
```

## Summary

**Key Points**:
1. LLM does NOT keep looping - it's execute-once by default
2. Three explicit approval gates (cost, risk, files)
3. User always controls when changes hit disk
4. Sandbox protects filesystem until `/apply`
5. Full trace available via `/trace` command

**To test the flow yourself**:
```bash
cd crew-cli
npm run build
./bin/crew repl

# Try these in order:
crew(manual)> /mode builder
crew(builder)> build me a simple express server
crew(builder)> /trace
crew(builder)> /preview
crew(builder)> /apply
```
