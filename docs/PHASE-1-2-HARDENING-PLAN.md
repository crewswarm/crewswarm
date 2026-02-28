# Phase 1-2 Production Hardening - Implementation Plan

**Goal:** Complete 6 outstanding items → 9/10 → 10/10 production ready  
**Total Time:** 10-12 hours  
**Order:** Critical first, then Quality of Life

---

## 🔥 Item 1: Bridge Cap / Queue Limit / Jitter (2-3 hrs)

### Problem
No protection against runaway dispatches. If PM loop or external client sends 1000 tasks, all 1000 spawn simultaneously → system crash.

### Solution
**Max concurrent tasks per agent + queue with overflow handling**

### Implementation

**File: `gateway-bridge.mjs`**

```javascript
// Add at top (global state)
const AGENT_TASK_QUEUES = new Map(); // agentId → { active: Set(), pending: Queue() }
const MAX_CONCURRENT_PER_AGENT = Number(process.env.CREWSWARM_MAX_CONCURRENT || 5);
const MAX_QUEUE_SIZE = Number(process.env.CREWSWARM_MAX_QUEUE || 20);

class TaskQueue {
  constructor() {
    this.items = [];
  }
  enqueue(item) { this.items.push(item); }
  dequeue() { return this.items.shift(); }
  size() { return this.items.length; }
}

function getOrCreateQueue(agentId) {
  if (!AGENT_TASK_QUEUES.has(agentId)) {
    AGENT_TASK_QUEUES.set(agentId, {
      active: new Set(),
      pending: new TaskQueue()
    });
  }
  return AGENT_TASK_QUEUES.get(agentId);
}

async function tryDispatchWithCap(agentId, taskFn, taskId) {
  const queue = getOrCreateQueue(agentId);
  
  // Check if at capacity
  if (queue.active.size >= MAX_CONCURRENT_PER_AGENT) {
    // Check if queue is full
    if (queue.pending.size() >= MAX_QUEUE_SIZE) {
      throw new Error(`Agent ${agentId} queue full (${MAX_QUEUE_SIZE} pending). Rejecting task ${taskId}.`);
    }
    
    // Queue it
    console.log(`[${agentId}] At capacity (${queue.active.size}/${MAX_CONCURRENT_PER_AGENT}). Queuing task ${taskId} (${queue.pending.size() + 1} in queue)`);
    
    return new Promise((resolve, reject) => {
      queue.pending.enqueue({ taskFn, taskId, resolve, reject });
    });
  }
  
  // Execute immediately
  queue.active.add(taskId);
  console.log(`[${agentId}] Executing task ${taskId} (${queue.active.size}/${MAX_CONCURRENT_PER_AGENT} active)`);
  
  try {
    const result = await taskFn();
    return result;
  } finally {
    queue.active.delete(taskId);
    
    // Process next in queue
    if (queue.pending.size() > 0) {
      const next = queue.pending.dequeue();
      console.log(`[${agentId}] Task ${taskId} done. Starting queued task ${next.taskId} (${queue.pending.size()} still queued)`);
      
      // Execute next task asynchronously (don't block current completion)
      tryDispatchWithCap(agentId, next.taskFn, next.taskId)
        .then(next.resolve)
        .catch(next.reject);
    }
  }
}
```

**Wrap existing dispatch in `tryDispatchWithCap`:**

```javascript
// In handleIncomingTask or main dispatch handler
const taskId = envelope.taskId || `task-${Date.now()}`;
const agentId = envelope.to || CREWSWARM_RT_AGENT;

await tryDispatchWithCap(agentId, async () => {
  // Existing task execution logic here
  return await executeTask(...);
}, taskId);
```

**Add jitter for retries (already in rt-envelope.mjs, verify it's active):**

```javascript
// In retry logic
const jitter = Math.random() * 1000; // 0-1000ms random jitter
const retryAfterMs = (RETRY_BACKOFF_MS * (2 ** attempt)) + jitter;
```

**Testing:**
```bash
# Test queue overflow
for i in {1..30}; do
  node gateway-bridge.mjs --send crew-coder "Create test-$i.txt" &
done
# Should see: 5 active, 20 queued, 5 rejected
```

---

## 🔥 Item 2: Canonical JSON Dispatch Schema (1-2 hrs)

### Problem
No standardized payload format. Different dispatchers send different shapes. Hard to debug, easy to break.

### Solution
**JSON Schema + validation at RT envelope entry point**

### Implementation

**File: `schemas/dispatch-schema.json` (NEW)**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CrewSwarm Task Dispatch",
  "type": "object",
  "required": ["type", "to", "payload"],
  "properties": {
    "type": {
      "type": "string",
      "enum": ["command.run_task", "command.dispatch", "command.skill"]
    },
    "to": {
      "type": "string",
      "description": "Target agent ID (e.g., crew-coder, broadcast)"
    },
    "from": {
      "type": "string",
      "description": "Sender agent ID (e.g., crew-lead)"
    },
    "taskId": {
      "type": "string",
      "description": "Unique task identifier"
    },
    "correlationId": {
      "type": "string",
      "description": "Trace ID for end-to-end request tracking"
    },
    "priority": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "default": "medium"
    },
    "payload": {
      "type": "object",
      "required": ["prompt"],
      "properties": {
        "prompt": {
          "type": "string",
          "minLength": 1
        },
        "agent": { "type": "string" },
        "projectDir": { "type": "string" },
        "model": { "type": "string" },
        "skill": { "type": "string" },
        "params": { "type": "object" }
      }
    }
  }
}
```

**File: `lib/runtime/schema-validator.mjs` (NEW)**

```javascript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(__dirname, "../../schemas");

let _dispatchSchema = null;

export function loadDispatchSchema() {
  if (!_dispatchSchema) {
    const schemaPath = path.join(SCHEMA_DIR, "dispatch-schema.json");
    _dispatchSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  }
  return _dispatchSchema;
}

export function validateDispatch(envelope) {
  const schema = loadDispatchSchema();
  const errors = [];
  
  // Required fields
  if (!envelope.type) errors.push("Missing required field: type");
  if (!envelope.to) errors.push("Missing required field: to");
  if (!envelope.payload) errors.push("Missing required field: payload");
  
  // Type validation
  const validTypes = ["command.run_task", "command.dispatch", "command.skill"];
  if (envelope.type && !validTypes.includes(envelope.type)) {
    errors.push(`Invalid type: ${envelope.type}. Must be one of: ${validTypes.join(", ")}`);
  }
  
  // Payload validation
  if (envelope.payload && !envelope.payload.prompt && !envelope.payload.skill) {
    errors.push("payload must contain either 'prompt' or 'skill'");
  }
  
  // Priority validation
  if (envelope.priority && !["low", "medium", "high"].includes(envelope.priority)) {
    errors.push(`Invalid priority: ${envelope.priority}`);
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
```

**File: `lib/engines/rt-envelope.mjs` (MODIFY)**

```javascript
import { validateDispatch } from "../runtime/schema-validator.mjs";

// In handleIncomingTask, add validation at the top
export async function handleIncomingTask(envelope, client) {
  const validation = validateDispatch(envelope);
  
  if (!validation.valid) {
    console.error(`[RT] Invalid dispatch envelope:`, validation.errors);
    
    client.publish({
      channel: "done",
      type: "task.failed",
      to: envelope.from,
      taskId: envelope.taskId,
      payload: {
        error: "Invalid dispatch format",
        details: validation.errors,
        hint: "See schemas/dispatch-schema.json for required format"
      }
    });
    
    client.ack({ messageId: envelope.id, status: "failed", note: "schema validation failed" });
    return;
  }
  
  // Continue with existing logic...
}
```

**Testing:**
```bash
# Test invalid dispatch (no prompt)
node -e "require('./gateway-bridge.mjs').sendTask('crew-coder', {})"
# Should reject with schema error

# Test valid dispatch
node gateway-bridge.mjs --send crew-coder "Valid task"
# Should succeed
```

---

## 🔥 Item 3: Coordinator-Only Dispatch Tests (2-3 hrs)

### Problem
No tests verifying crew-lead can orchestrate without direct bridge access. Architecture could regress.

### Solution
**Integration test: crew-lead → RT → bridge → response**

### Implementation

**File: `tests/integration/coordinator-dispatch.test.mjs` (NEW)**

```javascript
#!/usr/bin/env node
/**
 * Integration test: Coordinator-only dispatch
 * Verifies crew-lead can orchestrate tasks via RT bus without direct bridge access
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_TOKEN = "coordinator-test-" + Date.now();
const TEST_PORT = 18889;
const CREW_LEAD_PORT = 5010;

console.log("🧪 Coordinator-Only Dispatch Test");
console.log("   Verifies crew-lead → RT bus → bridge architecture");

// Step 1: Start RT daemon
console.log("\n1️⃣  Starting RT daemon...");
const rtProc = spawn("node", ["scripts/opencrew-rt-daemon.mjs"], {
  env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: TEST_TOKEN, CREWSWARM_RT_PORT: TEST_PORT },
  stdio: "ignore",
  detached: true
});
await sleep(3000);

// Step 2: Start crew-lead
console.log("2️⃣  Starting crew-lead...");
const leadProc = spawn("node", ["crew-lead.mjs"], {
  env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: TEST_TOKEN, CREW_LEAD_PORT },
  stdio: "ignore",
  detached: true
});
await sleep(2000);

// Step 3: Start one bridge (crew-coder)
console.log("3️⃣  Starting crew-coder bridge...");
const bridgeProc = spawn("node", ["gateway-bridge.mjs", "--agent", "crew-coder"], {
  env: { ...process.env, CREWSWARM_RT_AUTH_TOKEN: TEST_TOKEN },
  stdio: "ignore",
  detached: true
});
await sleep(3000);

try {
  // Step 4: Dispatch via crew-lead HTTP API (coordinator role)
  console.log("4️⃣  Dispatching task via crew-lead HTTP API...");
  
  const testFile = path.join(os.tmpdir(), `coord-test-${Date.now()}.txt`);
  const testContent = "COORDINATOR_TEST_OK";
  
  const response = await fetch(`http://127.0.0.1:${CREW_LEAD_PORT}/api/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "crew-coder",
      task: `Create file ${testFile} with content: ${testContent}`,
      timeout: 30000
    })
  });
  
  if (!response.ok) {
    throw new Error(`Dispatch failed: ${response.status} ${await response.text()}`);
  }
  
  const result = await response.json();
  console.log("   ✓ Dispatch accepted, taskId:", result.taskId);
  
  // Step 5: Wait for task completion
  console.log("5️⃣  Waiting for task completion...");
  let completed = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (fs.existsSync(testFile)) {
      const content = fs.readFileSync(testFile, "utf8");
      if (content.includes(testContent)) {
        completed = true;
        break;
      }
    }
  }
  
  // Step 6: Verify result
  console.log("6️⃣  Verifying result...");
  assert.ok(completed, "Task did not complete within 30 seconds");
  assert.ok(fs.existsSync(testFile), "Output file not created");
  
  const finalContent = fs.readFileSync(testFile, "utf8");
  assert.ok(finalContent.includes(testContent), "Output file has wrong content");
  
  console.log("   ✓ File created with correct content");
  
  // Cleanup
  fs.unlinkSync(testFile);
  
  console.log("\n✅ All tests passed!");
  console.log("   Architecture verified: crew-lead orchestrates via RT bus only");
  
} catch (err) {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
} finally {
  // Kill processes
  console.log("\n🧹 Cleaning up...");
  try { process.kill(-rtProc.pid, "SIGKILL"); } catch {}
  try { process.kill(-leadProc.pid, "SIGKILL"); } catch {}
  try { process.kill(-bridgeProc.pid, "SIGKILL"); } catch {}
}
```

**Add to `package.json`:**

```json
{
  "scripts": {
    "test:coordinator": "node tests/integration/coordinator-dispatch.test.mjs"
  }
}
```

**Add to CI (`smoke.yml`):**

```yaml
- name: Coordinator dispatch test
  run: npm run test:coordinator
```

---

## 💡 Item 4: Correlation IDs End-to-End (2-3 hrs)

### Problem
When debugging, hard to trace a single request through: crew-lead → RT → bridge → LLM → response.

### Solution
**Generate correlationId at entry point, propagate through entire stack, include in all logs**

### Implementation

**File: `lib/runtime/correlation.mjs` (NEW)**

```javascript
import { AsyncLocalStorage } from "node:async_hooks";

const asyncLocalStorage = new AsyncLocalStorage();

export function generateCorrelationId() {
  return `cr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function runWithCorrelation(correlationId, fn) {
  return asyncLocalStorage.run(correlationId, fn);
}

export function getCorrelationId() {
  return asyncLocalStorage.getStore() || "no-correlation";
}

export function logWithCorrelation(level, message, ...args) {
  const corrId = getCorrelationId();
  console[level](`[${corrId}]`, message, ...args);
}
```

**File: `crew-lead.mjs` (MODIFY)**

```javascript
import { generateCorrelationId, runWithCorrelation, logWithCorrelation } from "./lib/runtime/correlation.mjs";

// In HTTP handler for /api/crew-lead/chat
app.post("/api/crew-lead/chat", async (req, res) => {
  const correlationId = req.headers["x-correlation-id"] || generateCorrelationId();
  
  return runWithCorrelation(correlationId, async () => {
    logWithCorrelation("info", "Received chat message:", req.body.message?.slice(0, 50));
    
    // Existing logic, but all logs use logWithCorrelation
    // ...
    
    // When dispatching to RT, include correlationId
    client.publish({
      type: "command.run_task",
      to: "crew-coder",
      correlationId, // ← Add this
      payload: { prompt: task }
    });
  });
});
```

**File: `gateway-bridge.mjs` (MODIFY)**

```javascript
import { runWithCorrelation, logWithCorrelation } from "./lib/runtime/correlation.mjs";

// In RT message handler
rtClient.on("message", async (envelope) => {
  const correlationId = envelope.correlationId || "no-corr";
  
  return runWithCorrelation(correlationId, async () => {
    logWithCorrelation("info", `Received task from ${envelope.from}`);
    
    // All logs in task execution use logWithCorrelation
    // ...
  });
});
```

**File: `lib/engines/rt-envelope.mjs` (MODIFY)**

```javascript
import { getCorrelationId, logWithCorrelation } from "../runtime/correlation.mjs";

// In handleIncomingTask
export async function handleIncomingTask(envelope, client) {
  logWithCorrelation("info", `Processing ${envelope.type} for ${envelope.to}`);
  
  // When calling LLM
  logWithCorrelation("info", "Calling LLM with prompt:", prompt.slice(0, 100));
  
  // When publishing result
  client.publish({
    channel: "done",
    type: "task.done",
    correlationId: getCorrelationId(), // ← Add this
    // ...
  });
}
```

**Testing:**
```bash
# Dispatch a task and grep for correlation ID
curl -X POST http://127.0.0.1:5010/api/crew-lead/chat \
  -H "x-correlation-id: test-123" \
  -d '{"message":"Create hello.txt"}' | tee /tmp/test.log

# All logs should show [test-123]
grep "test-123" ~/.crewswarm/logs/*.log
```

---

## 💡 Item 5: `openswitchctl health` Command (1 hr)

### Problem
No quick way to check system health. Have to manually check multiple endpoints.

### Solution
**Single command that checks everything, exits 0 (healthy) or 1 (unhealthy)**

### Implementation

**File: `scripts/openswitchctl` (ADD health subcommand)**

```bash
health() {
  banner "🩺  CrewSwarm Health Check"
  
  local failures=0
  
  # 1. RT Bus
  step "RT Bus (port 18889)"
  if curl -sf http://127.0.0.1:18889/status >/dev/null 2>&1; then
    pass "RT bus responding"
  else
    fail "RT bus not responding"
    failures=$((failures + 1))
  fi
  
  # 2. crew-lead
  step "crew-lead (port 5010)"
  if curl -sf http://127.0.0.1:5010/status >/dev/null 2>&1; then
    pass "crew-lead responding"
  else
    fail "crew-lead not responding"
    failures=$((failures + 1))
  fi
  
  # 3. Agents connected
  step "Agents"
  local agent_count=$(curl -sf http://127.0.0.1:18889/status 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log((JSON.parse(d).agents||[]).length)}catch{console.log(0)}})")
  
  if [[ "$agent_count" -gt 0 ]]; then
    pass "$agent_count agents connected"
  else
    fail "No agents connected"
    failures=$((failures + 1))
  fi
  
  # 4. LLM reachable (test dispatch to crew-main)
  step "LLM connectivity"
  local test_reply=$(timeout 10 node "$OPENCLAW_DIR/gateway-bridge.mjs" --send crew-main "Reply: OK" 2>/dev/null || echo "")
  
  if echo "$test_reply" | grep -q "OK"; then
    pass "LLM responding via crew-main"
  else
    fail "LLM not responding"
    failures=$((failures + 1))
  fi
  
  # 5. Dashboard
  step "Dashboard (port 4319)"
  if curl -sf http://127.0.0.1:4319 >/dev/null 2>&1; then
    pass "Dashboard responding"
  else
    warn "Dashboard not running (optional)"
  fi
  
  # Summary
  banner "━━━ Health Check Results ━━━"
  if [[ "$failures" -eq 0 ]]; then
    printf "${GRN}${BLD}✅ System is healthy${RST}\n"
    return 0
  else
    printf "${RED}${BLD}❌ $failures check(s) failed${RST}\n"
    return 1
  fi
}

# Add to case statement
case "$1" in
  # ... existing cases ...
  health)
    health
    ;;
esac
```

**Testing:**
```bash
openswitchctl health
# Should show all green if system running

openswitchctl stop
openswitchctl health
# Should show failures and exit 1
```

---

## 💡 Item 6: CI Secrets Wired (30 min)

### Problem
Smoke tests can't run in CI because no secrets configured.

### Solution
**Add secrets to GitHub repo, update workflow to use them**

### Implementation

**Step 1: Add secrets to GitHub repo (requires admin)**

Go to: `https://github.com/CrewSwarm/CrewSwarm/settings/secrets/actions`

Add:
- `CREWSWARM_RT_TOKEN` = (generate: `openssl rand -hex 16`)
- `GROQ_API_KEY` = (from https://console.groq.com/keys)

**Step 2: Update `.github/workflows/smoke.yml`**

```yaml
name: Smoke Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  smoke:
    runs-on: ubuntu-latest
    
    env:
      CREWSWARM_RT_AUTH_TOKEN: ${{ secrets.CREWSWARM_RT_TOKEN }}
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Bootstrap config
        run: |
          mkdir -p ~/.crewswarm
          echo "{\"rt\":{\"authToken\":\"$CREWSWARM_RT_AUTH_TOKEN\"}}" > ~/.crewswarm/config.json
          # Copy minimal crewswarm.json (created by install script normally)
          node -e "fs.writeFileSync(process.env.HOME+'/.crewswarm/crewswarm.json',JSON.stringify({agents:[{id:'crew-coder',model:'groq/llama-3.3-70b-versatile'}],providers:{groq:{apiKey:process.env.GROQ_API_KEY}}}))"
      
      - name: Run smoke tests
        run: npm run smoke
      
      - name: Run coordinator test
        run: npm run test:coordinator
```

**Testing:**
```bash
# Local test (simulating CI)
export CREWSWARM_RT_AUTH_TOKEN=$(openssl rand -hex 16)
export GROQ_API_KEY=gsk_...
npm run smoke
```

---

## 📊 Implementation Order

| # | Item | Time | Why This Order |
|---|------|------|----------------|
| 1 | Bridge Cap | 2-3h | Most critical - prevents crashes |
| 2 | Canonical Schema | 1-2h | Quick win, prevents bugs |
| 4 | Correlation IDs | 2-3h | Makes debugging the next items easier |
| 3 | Coordinator Tests | 2-3h | Validates #1 and #2 work correctly |
| 5 | Health Command | 1h | Quick win for ops |
| 6 | CI Secrets | 30m | Easy finish, automation |

**Total: 10-12 hours**

---

## ✅ Acceptance Criteria

After all 6 items:

- ✅ System handles 100+ concurrent dispatches without crashing
- ✅ All dispatches validate against schema, reject malformed
- ✅ Every request traceable end-to-end via correlation ID
- ✅ Integration tests verify coordinator architecture
- ✅ `openswitchctl health` gives instant system status
- ✅ CI runs smoke tests automatically on every push

**Result: 10/10 Production Ready** 🎯

---

## 🚀 Next: Fix PM & Dispatch Issues

After hardening is done, we'll tackle:
- PM loop not marking items complete
- Dispatch not actually sending to agents
- Whatever else is "completely fucked" 😄

Want me to start implementing these 6 items now, or should we skip straight to fixing the broken PM/dispatch first?
