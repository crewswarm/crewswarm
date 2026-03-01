# PM Loop Real-World Test Guide

## Overview

The **PM Loop** is CrewSwarm's autonomous meta-agent that reads a `ROADMAP.md`, expands tasks via an LLM orchestrator, dispatches them to the 3-tier system, and updates the roadmap automatically. This creates a **fully autonomous build-out system**.

## How It Works

```
User writes ROADMAP.md → PM Loop (LLM Orchestrator) → 3-Tier System → Updates ROADMAP.md → Repeat
```

**Key Components:**
1. **PM Loop** (`pm-loop.mjs`) - Meta-agent orchestrator
2. **Orchestrator LLM** - Perplexity Sonar Pro / Groq / Cerebras (expandsroadmap items)
3. **Gateway** (`crew-lead`) - Routes to specialist agents
4. **3-Tier System** - Router → Planner → Worker Pool
5. **ROADMAP.md** - Source of truth for pending tasks

## Setup for Real-World Test

### 1. Create a Test Roadmap

```bash
cd /Users/jeffhobbs/Desktop/CrewSwarm
mkdir -p test-autonomous-project
cd test-autonomous-project

cat > ROADMAP.md << 'EOF'
# Autonomous Build Test - Simple Blog App

## Phase 1: Core Setup
- [ ] Create project structure with package.json
- [ ] Add Express.js server with basic routing
- [ ] Set up SQLite database with posts table

## Phase 2: API Endpoints
- [ ] Implement GET /api/posts endpoint
- [ ] Implement POST /api/posts endpoint
- [ ] Add error handling middleware

## Phase 3: Frontend
- [ ] Create HTML template with CSS
- [ ] Add JavaScript for fetching posts
- [ ] Implement post creation form

## Phase 4: Testing
- [ ] Write unit tests for API endpoints
- [ ] Add integration tests
- [ ] Run full test suite
EOF
```

### 2. Start the Gateway

```bash
# Terminal 1: Start crew-lead gateway
cd /Users/jeffhobbs/Desktop/CrewSwarm
node gateway-bridge.mjs
```

### 3. Run the PM Loop

```bash
# Terminal 2: Start PM Loop
cd /Users/jeffhobbs/Desktop/CrewSwarm
PM_PROJECT_ID=blog-test \
PM_ROADMAP_FILE=/Users/jeffhobbs/Desktop/CrewSwarm/test-autonomous-project/ROADMAP.md \
PM_MAX_ITEMS=12 \
PM_SELF_EXTEND=1 \
PM_EXTEND_EVERY=5 \
node pm-loop.mjs
```

**What happens:**
1. PM Loop reads `ROADMAP.md`
2. Finds first `- [ ]` item: "Create project structure with package.json"
3. Sends to Orchestrator LLM (Perplexity/Groq) to expand into detailed task
4. LLM generates: `"Create a Node.js project with package.json, add express and sqlite3 dependencies, create src/ and public/ directories"`
5. Dispatches to `crew-coder` via gateway
6. crew-coder uses 3-tier system to implement
7. PM Loop marks item `- [x]` in ROADMAP.md
8. Moves to next item
9. After 5 completed items, LLM generates 3-5 NEW roadmap items
10. Continues until MAX_ITEMS or manual stop

### 4. Monitor Progress

```bash
# Terminal 3: Watch the roadmap update in real-time
watch -n 2 cat /Users/jeffhobbs/Desktop/CrewSwarm/test-autonomous-project/ROADMAP.md

# Terminal 4: Watch PM Loop logs
tail -f /Users/jeffhobbs/Desktop/CrewSwarm/orchestrator-logs/pm-loop.jsonl
```

### 5. Stop the Loop

```bash
# Create stop signal file
touch /Users/jeffhobbs/Desktop/CrewSwarm/orchestrator-logs/pm-loop-blog-test.stop

# Or via Dashboard UI: Projects → PM Loop → Stop
```

## Configuration Options

### Environment Variables

```bash
# Project identification
PM_PROJECT_ID=my-project          # Unique ID for multi-project support

# Roadmap settings
PM_ROADMAP_FILE=/path/to/ROADMAP.md   # Custom roadmap location
PM_MAX_ITEMS=200                   # Stop after N completed items
PM_SELF_EXTEND=1                   # Auto-generate new roadmap items (1=yes, 0=no)
PM_EXTEND_EVERY=5                  # Generate new items every N completions

# Execution settings
PM_MAX_CONCURRENT=20               # Max parallel tasks
PHASED_TASK_TIMEOUT_MS=600000      # 10min timeout per task
PM_AGENT_IDLE_TIMEOUT_MS=900000    # 15min idle timeout

# Agent routing
PM_USE_SPECIALISTS=1               # Route HTML→crew-frontend, JS→crew-backend
PM_CODER_AGENT=crew-coder-front    # Force all tasks to specific agent

# LLM provider (auto-detected from ~/.crewswarm/crewswarm.json or fallback)
GROQ_API_KEY=xxx                   # Fallback if no provider configured
```

### Command Line Options

```bash
# Dry run (show what PM would do, no actual execution)
node pm-loop.mjs --dry-run

# Limit items
node pm-loop.mjs --max-items 50

# Disable self-extending
node pm-loop.mjs --no-extend

# Custom project directory
node pm-loop.mjs --project-dir /path/to/project
```

## Real-World Test Scenarios

### Scenario 1: Small Feature (5-10 items)
**Goal:** Test basic orchestration loop  
**Roadmap:** Simple REST API with 3 endpoints  
**Duration:** ~30-60 minutes  
**Metrics:** Success rate, time per item, cost per item

### Scenario 2: Medium Project (20-30 items)
**Goal:** Test self-extending and specialist routing  
**Roadmap:** Full-stack CRUD app with auth  
**Duration:** ~2-4 hours  
**Metrics:** Self-extension quality, agent routing accuracy, total cost

### Scenario 3: Large Buildout (50+ items)
**Goal:** Stress test with real production complexity  
**Roadmap:** E-commerce platform with checkout, admin, search  
**Duration:** ~8-24 hours  
**Metrics:** Failure recovery, memory persistence, cost efficiency

## Monitoring & Debugging

### Log Files

```bash
# PM Loop execution log
tail -f orchestrator-logs/pm-loop.jsonl

# Individual agent logs
tail -f orchestrator-logs/crew-coder-*.jsonl
tail -f orchestrator-logs/crew-fixer-*.jsonl

# Gateway logs
tail -f ~/.crewswarm/logs/gateway-bridge.jsonl
```

### Dashboard UI

Navigate to **Projects** tab:
- View live PM Loop status badge (idle/running/stopping)
- See pending roadmap items count
- Click **Start PM Loop** / **Stop PM Loop**
- View live execution log
- Inspect roadmap content

### Health Checks

```bash
# Check if PM Loop is running
cat orchestrator-logs/pm-loop-blog-test.pid

# Check for stop signal
ls orchestrator-logs/pm-loop-blog-test.stop

# Test gateway connectivity
curl http://127.0.0.1:5010/api/health
```

## Expected Metrics (Benchmark Goals)

Based on the 3-tier architecture benchmarks:

| Metric | Sequential | PM Loop (3-Tier) |
|--------|-----------|------------------|
| **Time per 6-item feature** | ~184s | ~62s (2.96x faster) |
| **Cost per 6-item feature** | $0.042 | $0.045 (+7% overhead) |
| **Success rate** | 100% | 100% (with retry) |
| **Merge conflicts** | N/A | 0 (sandbox isolation) |

### Per-Item Breakdown

- **Simple task** (e.g., "Add logging"): 15-30s, $0.003-0.005
- **Medium task** (e.g., "Add API endpoint"): 45-90s, $0.008-0.012
- **Complex task** (e.g., "Implement auth flow"): 120-180s, $0.015-0.025

## Validation Checklist

After your real-world test:

- [ ] All roadmap items marked `[x]` or `[!]`
- [ ] Self-extended roadmap has new generated items
- [ ] All generated code is syntactically valid
- [ ] Tests pass (if roadmap included test items)
- [ ] Total cost matches expected budget
- [ ] No unhandled errors in logs
- [ ] PM Loop stopped cleanly (no zombie processes)

## Troubleshooting

### PM Loop Won't Start

```bash
# Check if already running
cat orchestrator-logs/pm-loop-blog-test.pid
ps aux | grep pm-loop

# Kill stale process
kill $(cat orchestrator-logs/pm-loop-blog-test.pid)
rm orchestrator-logs/pm-loop-blog-test.pid
```

### Gateway Not Reachable

```bash
# Verify gateway is running
curl http://127.0.0.1:5010/api/health

# Check gateway logs
tail -f ~/.crewswarm/logs/gateway-bridge.jsonl

# Restart gateway
pkill -f gateway-bridge
node gateway-bridge.mjs
```

### Tasks Failing Repeatedly

1. Check agent logs for error patterns
2. Verify LLM API keys are valid
3. Check if roadmap items are too vague (expand manually)
4. Review blast-radius gates (might be blocking auto-apply)

### Self-Extension Generating Low-Quality Items

Edit the orchestrator prompt in `pm-loop.mjs` (lines ~300-400) to:
- Add more context about project goals
- Include examples of good roadmap items
- Add constraints on item scope

## Integration with crew-cli

The PM Loop **does not** currently use `crew-cli`'s 3-tier architecture directly. Instead:

1. PM Loop → Gateway (`crew-lead`)
2. Gateway → Agent bridges (crew-coder, crew-fixer, etc.)
3. Each agent bridge → (Optional) Use `crew-cli` as execution engine

**Future Enhancement:** Route PM Loop tasks through `crew-cli plan --parallel` for automatic 3-tier orchestration:

```javascript
// In pm-loop.mjs, replace gateway dispatch with:
const result = await execAsync(`crew plan "${task}" --parallel --auto-apply --project ${OUTPUT_DIR}`);
```

This would give you:
- ✅ Router LLM classification
- ✅ Planner LLM task breakdown
- ✅ Worker Pool parallel execution
- ✅ AgentKeeper memory persistence
- ✅ All crew-cli safety gates (blast-radius, LSP, validation)

## Summary

Your PM Loop is a **fully autonomous coding system** that:
1. ✅ Reads roadmaps
2. ✅ Expands tasks via LLM orchestrator
3. ✅ Dispatches to 3-tier specialist agents
4. ✅ Updates roadmap automatically
5. ✅ Self-extends with new tasks
6. ✅ Runs indefinitely until stopped

**To run a real-world test:** Just create a `ROADMAP.md`, start the gateway, and run `node pm-loop.mjs` with appropriate env vars. The system will autonomously build out your entire project!

**Next Step:** Try the "Scenario 1: Small Feature" test above to validate the full loop. 🚀
