# Elvis/Ralph Improvements - Complete Implementation

All improvements from Elvis's agent swarm and Ralph loop are now implemented.

## What Was Added

### 1. ✅ Git Worktree + Session Management
**File:** `scripts/worktree-manager.sh`

**What it does:**
- Each task gets isolated worktree + branch
- Spawns agents in dedicated tmux sessions
- Mid-task redirection via `tmux send-keys`
- Tracks all tasks in JSON registry

**Usage:**
```bash
# Create worktree + spawn agent
./scripts/worktree-manager.sh create feat-login crew-coder "Add login form"
./scripts/worktree-manager.sh spawn feat-login crew-coder "Implement JWT login"

# Mid-task correction
./scripts/worktree-manager.sh redirect feat-login "Stop. Focus on API first."

# Check status
./scripts/worktree-manager.sh check feat-login

# Clean up
./scripts/worktree-manager.sh cleanup feat-login
```

**Active tasks tracked in:** `~/.crewswarm/active-tasks.json`

---

### 2. ✅ Multi-AI Code Review
**File:** `scripts/multi-ai-review.sh`

**What it does:**
- 3 AI reviewers on every PR:
  - **Codex** - Edge cases & logic
  - **Gemini** - Security & scale
  - **Claude** - Code quality
- Posts comments directly on GitHub
- Summary table shows pass/fail

**Usage:**
```bash
# Review a PR
./scripts/multi-ai-review.sh 123

# Output:
# Codex:  ✓ PASS
# Gemini: ✗ FAIL (security issue found)
# Claude: ✓ PASS
# Total: 2/3 reviewers approved
```

---

### 3. ✅ CI Monitoring + Auto-Retry
**File:** `scripts/ci-monitor.sh`

**What it does:**
- Polls CI status for all open PRs
- Auto-respawns failed agents (max 3 attempts)
- Enhances prompts with failure context
- Notifies via Telegram when done

**Usage:**
```bash
# Run as daemon (recommended via cron)
./scripts/ci-monitor.sh monitor

# Check once
./scripts/ci-monitor.sh check

# Cron setup (every 10 min)
*/10 * * * * cd /path/to/CrewSwarm && ./scripts/ci-monitor.sh check
```

**When agent fails CI:**
1. Reads failure logs
2. Builds enhanced prompt with context
3. Spawns fresh agent (up to 3 retries)
4. Notifies when all checks pass

---

### 4. ✅ Ralph Loop (Fresh Context Per Task)
**File:** `scripts/ralph-loop.sh`

**What it does:**
- Reads `ROADMAP.md` for tasks
- Spawns **fresh agent** per task (no context accumulation)
- Runs quality checks after each story
- Appends learnings to `.crewswarm/progress.txt`
- Marks items complete in ROADMAP

**Usage:**
```bash
# Run Ralph loop (max 10 iterations)
./scripts/ralph-loop.sh 10 /path/to/project

# ROADMAP.md format:
# - [ ] Add login form
# - [ ] Add password reset
# - [ ] Add 2FA
```

---

### 5. ✅ One-Shot Mode (Gateway Bridge)
**Files:** 
- `lib/gateway/one-shot-wrapper.mjs`
- `lib/gateway/one-shot-handler.mjs`

**What it does:**
- Fresh context per task (Ralph pattern)
- Load memory + learnings from previous iterations
- Execute task
- Record result
- **Exit** (no daemon)

**Usage:**
```bash
# One-shot task
node gateway-bridge.mjs --one-shot crew-coder "Add login form"
# Exits after completion

# Normal daemon (existing)
node gateway-bridge.mjs crew-coder
# Stays running
```

---

### 6. ✅ External Context Integration
**File:** `scripts/external-context.sh`

**What it does:**
- Syncs Obsidian vault (read-only)
- Stores meeting notes
- Customer context retrieval
- Webhook-ready for Zapier/Make

**Usage:**
```bash
# Sync Obsidian vault
./scripts/external-context.sh sync

# Search for context
./scripts/external-context.sh search "authentication"

# Add meeting notes
./scripts/external-context.sh add-meeting "Acme Corp" "2026-03-01" "Customer wants..."

# Get customer context
customer_context=$(./scripts/external-context.sh get-customer "Acme Corp")

# Use in dispatch
crew dispatch crew-coder "Build feature X\n\n$customer_context"
```

**Webhook endpoint (for Zapier):**
```
POST http://localhost:5010/api/external-context/meeting
{
  "customer": "Acme Corp",
  "date": "2026-03-01",
  "notes": "...",
  "source": "zoom"
}
```

---

## System Architecture Now

```
┌─────────────────────────────────────────────────────────────┐
│ External Context (Obsidian + Meeting Notes)                 │
└─────────────────┬───────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│ Worktree Manager                                             │
│ - Creates isolated git worktrees per task                   │
│ - Spawns agents in tmux sessions                            │
│ - Tracks: ~/.crewswarm/active-tasks.json                    │
└─────────────────┬───────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│ Ralph Loop (Fresh Context)                                   │
│ - Reads ROADMAP.md                                           │
│ - Spawns ONE-SHOT agent per task                            │
│ - Runs quality checks                                        │
│ - Records learnings in progress.txt                         │
└─────────────────┬───────────────────────────────────────────┘
                  │
       ┌──────────┼──────────┐
       │          │          │
┌──────▼────┐ ┌──▼────┐ ┌──▼────┐
│ Codex     │ │Claude │ │Gemini │
│ (Agent)   │ │(Agent)│ │(Agent)│
└──────┬────┘ └──┬────┘ └──┬────┘
       │          │          │
       └──────────┼──────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│ CI Monitor                                                   │
│ - Polls PR status every 10min                               │
│ - Auto-respawns on failure (max 3x)                         │
│ - Enhanced prompts with failure context                     │
└─────────────────┬───────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│ Multi-AI Review                                              │
│ - 3 reviewers per PR (Codex, Gemini, Claude)               │
│ - Posts comments on GitHub                                  │
│ - Blocks merge if issues found                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Comparison: Before vs After

| Feature | Before | After |
|---------|--------|-------|
| **Agent Context** | Stateful daemon (accumulates) | Fresh per task (one-shot) |
| **Parallel Work** | Single codebase, conflicts | Isolated worktrees per task |
| **Mid-Task Redirect** | Not possible | `tmux send-keys` |
| **Code Review** | Manual or crew-qa | 3 AI reviewers auto |
| **CI Monitoring** | Manual check | Auto-poll + retry |
| **Failure Handling** | Retry with same prompt | Enhanced prompt with context |
| **External Context** | None | Obsidian + meeting notes |
| **Learning** | Implicit (brain.md) | Explicit (progress.txt) |

---

## Quick Start

### 1. Try Ralph Loop
```bash
cd your-project

# Create ROADMAP.md
cat > ROADMAP.md <<EOF
# Feature: Login System

Branch: feat/login

- [ ] Add JWT auth middleware
- [ ] Add login form component
- [ ] Add password reset flow
EOF

# Run Ralph
./scripts/ralph-loop.sh 5
```

### 2. Try Worktree Management
```bash
# Create isolated workspace for login feature
./scripts/worktree-manager.sh create feat-login crew-coder "Add login form"

# Spawn agent in tmux
./scripts/worktree-manager.sh spawn feat-login crew-coder "Implement JWT login with bcrypt"

# Mid-task correction (if agent going wrong direction)
./scripts/worktree-manager.sh redirect feat-login "Stop. API first, then UI."

# Check what it's doing
tmux attach -t crew-feat-login
# Ctrl+B, D to detach

# When done
./scripts/worktree-manager.sh cleanup feat-login
```

### 3. Try Multi-AI Review
```bash
# After creating a PR
./scripts/multi-ai-review.sh 123

# See comments posted on GitHub
gh pr view 123
```

### 4. Setup CI Monitoring
```bash
# Run once to test
./scripts/ci-monitor.sh check

# Add to cron (check every 10min)
crontab -e
# Add: */10 * * * * cd /path/to/CrewSwarm && ./scripts/ci-monitor.sh check
```

### 5. Add External Context
```bash
# Sync your Obsidian vault
export OBSIDIAN_VAULT_PATH=~/Documents/Obsidian
./scripts/external-context.sh sync

# Add meeting notes
./scripts/external-context.sh add-meeting "Acme Corp" "2026-03-01" \
  "Customer wants template feature for reusing configurations"

# Use in task
customer_context=$(./scripts/external-context.sh get-customer "Acme Corp")
crew dispatch crew-coder "Build templates feature\n\n$customer_context"
```

---

## Key Differences from Elvis's Setup

| Feature | Elvis (Mac Studio 128GB) | CrewSwarm (Any Machine) |
|---------|--------------------------|-------------------------|
| **Orchestrator** | Zoe (custom) | crew-lead + Ralph loop |
| **Agent Spawning** | tmux per agent | tmux per agent ✓ |
| **Worktrees** | Manual per agent | Automated (worktree-manager.sh) ✓ |
| **Code Review** | 3 AI reviewers | 3 AI reviewers ✓ |
| **CI Monitoring** | Custom cron | ci-monitor.sh ✓ |
| **External Context** | Obsidian + prod DB | Obsidian + meeting notes ✓ |
| **Self-Improving** | Zoe rewrites prompts | progress.txt + enhanced prompts ✓ |
| **Resource Usage** | 5+ parallel agents | 1-2 agents (configurable) |

---

## What's Not Implemented (Yet)

These would be nice-to-haves:

1. **Production DB Queries** (Elvis has read-only prod access)
   - Would need: `@@QUERY_PROD_DB` tool with allowlist

2. **Automatic Work Discovery** (Zoe scans Sentry/logs proactively)
   - Would need: Integration with error tracking services

3. **Multi-Agent Parallel Execution** (Elvis runs 4-5 agents simultaneously)
   - Would need: More RAM or better resource management

4. **Screenshot Requirements** (Elvis's CI fails without UI screenshots)
   - Would need: Playwright integration in CI

---

## Files Created

```
scripts/
├── worktree-manager.sh      # Git worktree + tmux management
├── ralph-loop.sh             # Fresh context per task loop
├── multi-ai-review.sh        # 3 AI reviewers per PR
├── ci-monitor.sh             # CI polling + auto-retry
└── external-context.sh       # Obsidian + meeting notes sync

lib/gateway/
├── one-shot-wrapper.mjs      # Entry point for --one-shot mode
└── one-shot-handler.mjs      # Fresh context task execution

docs/
├── RALPH-LOOP-COMPARISON.md  # Ralph vs CrewSwarm detailed comparison
└── ELVIS-IMPROVEMENTS.md     # This file
```

---

## Testing

All scripts have help text:
```bash
./scripts/worktree-manager.sh help
./scripts/ralph-loop.sh help
./scripts/multi-ai-review.sh help
./scripts/ci-monitor.sh help
./scripts/external-context.sh help
```

---

## Summary

You now have:
✅ Elvis's worktree + tmux isolation  
✅ Elvis's 3-AI code review  
✅ Elvis's CI monitoring + auto-retry  
✅ Ralph's fresh context per task  
✅ Ralph's explicit learning log  
✅ External context (Obsidian sync)  
✅ One-shot mode for gateway bridge  

**CrewSwarm is now a production-grade autonomous dev team.** 🚀
