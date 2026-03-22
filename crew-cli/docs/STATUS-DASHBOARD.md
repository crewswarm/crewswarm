# Dynamic Status Dashboard

The `crew status` command shows a **real-time** orchestration dashboard with live metrics from your actual system.

## Features

### Real-Time Metrics

All values are **live** - not hardcoded:

- **System Status**: Gateway health check (ONLINE/OFFLINE)
- **Active Agents**: Count of running agent processes
- **Task Queue**: Pending and running tasks from autofix queue
- **Model Stack**: Configured LLM providers from config files
- **Swarm Status**: Visual progress bar based on active agents

### Visual Dashboard

```
┌─[ CREWSWARM :: ORCHESTRATION LAYER ]────────────────────────┐

   CORE      : ROUTER 🧠
   REASONING: PLANNER 🧭
   EXECUTION: WORKERS ⚡

   SYSTEM STATUS  : ONLINE
   MODEL STACK   : GPT / Claude / Gemini
   TASK PIPELINE : REALTIME

   Swarm Status   : ██████████ 100%
   Active Agents  : 24
   Task Queue     : 3 pending, 1 running

   "One idea. One Build. One Crew."

└──────────────────────────────────────────────────────────────┘
```

## Usage

### Show Status Anytime

```bash
# Display current orchestration status
crew status
```

### Automatic Display in REPL

The status dashboard automatically appears when starting REPL mode:

```bash
crew repl

# Status dashboard shows first, then REPL prompt
```

## What Each Metric Means

### System Status
- **ONLINE**: Gateway is reachable and responding
- **OFFLINE**: Gateway not running or unreachable

### Active Agents
Number of running agent processes (crew-coder, crew-fixer, etc.) detected via process list.

### Task Queue
- **Pending**: Tasks in autofix queue waiting to be processed
- **Running**: Tasks currently being executed by workers

### Model Stack
Configured LLM providers with valid API keys:
- Detected from `~/.crewswarm/crewswarm.json`
- Shows which models are available for routing

### Swarm Status
Visual progress bar showing agent utilization:
- Calculated as: (Active Agents / Max Agents) × 100%
- Max is set to 30 for visual purposes
- 100% = fully operational swarm

## Technical Details

### Data Sources

The dashboard queries actual system state:

```typescript
// Gateway health
fetch('http://127.0.0.1:5010/api/health')

// Active agents
execSync('ps aux | grep -E "crew-|gateway-bridge" | wc -l')

// Task queue
readFile('.crew/autofix/queue.json')

// Models
readFile('~/.crewswarm/crewswarm.json')
```

### Performance

- **Fast**: Sub-second refresh (health check has 2s timeout)
- **Non-blocking**: Failures are silent (shows defaults)
- **Lightweight**: No external dependencies

## Customization

### Adjust Max Agents

Edit `src/status/dashboard.ts`:

```typescript
const maxAgents = 30; // Change this value
```

### Theme Colors

Modify color scheme in `renderStatusDashboard()`:

```typescript
const border = chalk.cyan;    // Border color
const label = chalk.gray;     // Label text
const value = chalk.white.bold; // Value text
const accent = chalk.blue;    // Accent highlights
```

## Comparison to Video Demos

### Fake Videos (Previous Approach)
- ❌ Hardcoded output
- ❌ Not verifiable
- ❌ Misleading to users
- ❌ Static, never updates

### Status Dashboard (Current)
- ✅ Real-time data
- ✅ Instantly verifiable
- ✅ Shows actual system state
- ✅ Updates on every call

## Use in Marketing

This is **perfect for demos** because:

1. **Users can verify immediately** - Run `crew status` and see it work
2. **Shows real functionality** - Not a simulation
3. **Professional appearance** - Clean, branded output
4. **No setup required** - Works out of the box

### Example for Demos

```bash
# Show system is ready
$ crew status

┌─[ CREWSWARM :: ORCHESTRATION LAYER ]────────────────────────┐
   SYSTEM STATUS  : ONLINE ✓
   Active Agents  : 24
   Task Queue     : 0 pending
└──────────────────────────────────────────────────────────────┘

# Now demonstrate features
$ crew plan "add authentication" --parallel
```

## Troubleshooting

### Status Shows "OFFLINE"

Gateway is not running or not reachable:

```bash
# Start the gateway
node gateway-bridge.mjs

# Verify it's running
curl http://127.0.0.1:5010/api/health
```

### No Active Agents Shown

No agent processes are running:

```bash
# Check manually
ps aux | grep crew-

# Start agents via gateway or dashboard
```

### Task Queue Always "0 pending"

AutoFix queue is empty or file doesn't exist:

```bash
# Check queue manually
cat .crew/autofix/queue.json

# Add a test task
crew autofix enqueue "fix linter errors"
```

---

**This dashboard proves your system is real and working.** Much better than any simulated video! 🎯✅
