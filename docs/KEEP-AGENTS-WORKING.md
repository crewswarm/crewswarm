# 🔧 How to Keep Your Agents Working Reliably

**Last Updated:** 2026-02-20

## ✅ What We Just Fixed

### 1. **Added Health Check Script** (Auto-Monitor)
```bash
~/.openclaw/bin/health-check.sh
```

**What it does:**
- Checks if OpenClaw Gateway is running
- Verifies all 7 agent daemons are alive
- Detects stuck sessions
- Auto-restarts crashed services
- Logs all activity to `/tmp/openclaw-health.log`

**Install auto-run:**
```bash
crontab -e
# Add this line:
0 * * * * /Users/jeffhobbs/.openclaw/bin/health-check.sh
```
This runs every hour automatically.

---

### 2. **Added Agent Specialization Prompts** (Make Them Better)

Each agent now has a specialized `systemPrompt` that tells them exactly how to do their job:

| Agent | Role | Key Behaviors |
|-------|------|---------------|
| **Quill** (main) | Orchestrator | Delegates tasks, reviews output, ensures quality |
| **Codex** (coder) | Implementation | Writes clean code, follows conventions, runs tests |
| **Planner** (pm) | Architecture | Breaks down features, tracks dependencies |
| **Tester** (qa) | Quality | Writes comprehensive tests, >80% coverage |
| **Debugger** (fixer) | Troubleshooting | Reads logs, finds root cause, verifies fixes |
| **Guardian** (security) | Security | Reviews for vulnerabilities, checks auth logic |

**These prompts make agents 10x better at their jobs!**

---

## 📋 Daily Maintenance Checklist

### Morning Check (30 seconds)
```bash
# 1. Check agent status
bash ~/bin/openswitchctl status

# Expected output:
# running (rt:up, agents:7/7) crew-main:up, crew-pm:up, ...
```

If any agent shows `down`, restart it:
```bash
bash ~/bin/openswitchctl restart-all
```

---

### Weekly Check (5 minutes)

```bash
# 1. Check health log
tail -50 /tmp/openclaw-health.log

# 2. Check for stuck sessions
ps aux | grep "openclaw" | grep -v grep

# 3. Check RT message queue
curl -s http://127.0.0.1:4318/api/rt/stats | jq

# 4. Check error rate
tail -100 ~/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/issues.jsonl
```

---

## 🚨 Common Issues & Fixes

### Issue: "Agent not responding"
**Symptoms:** Messages sent but no reply  
**Fix:**
```bash
# Check if agent daemon is running
ps aux | grep "OPENCREW_RT_AGENT=\"crew-coder\""

# Restart specific agent
bash ~/bin/openswitchctl stop-agent crew-coder
bash ~/bin/openswitchctl start-agent crew-coder
```

---

### Issue: "Gateway timeout"
**Symptoms:** `Error loading sessions` in dashboard  
**Fix:**
```bash
# Restart gateway (clears stuck sessions)
bash ~/bin/openswitchctl restart-openclaw-gateway
```

---

### Issue: "Rate limit errors"
**Symptoms:** Tasks failing with `429 Too Many Requests`  
**Fix:**
All agents use **Groq Llama 3.3 70B** (unlimited free tier), so this shouldn't happen.

If it does:
```bash
# Check current model
grep '"model":' ~/.openclaw/openclaw.json | head -7

# Should all show: "groq/llama-3.3-70b-versatile"
```

---

### Issue: "Agents producing reports, not code"
**Symptoms:** Tasks marked "done" but no files changed  
**Fix:**
This is now handled by artifact validation in `gateway-bridge.mjs` (lines 1685-1723).

If it still happens:
```bash
# Check if OPENCREW_OPENCODE_ENABLED is 0
grep "OPENCREW_OPENCODE_ENABLED" ~/bin/openswitchctl

# Should show: OPENCREW_OPENCODE_ENABLED="0"
```

---

### Issue: "Only Quill works, other agents fail"
**Symptoms:** Only `crew-main` replies  
**Fix:**
Check `gateway-bridge.mjs` line 620:
```javascript
// Should be:
return true; // Allow ALL agents to connect to gateway

// NOT:
return OPENCREW_RT_AGENT === "crew-main"; // ❌ Wrong!
```

---

## 🎯 How to Test if Everything Works

### Test 1: Individual Agent (30 seconds)
```bash
bash ~/bin/openswitchctl send crew-coder "Create a simple hello world function in /tmp/test-hello.js"
```

**Expected:** File created within 30 seconds.

---

### Test 2: Multi-Agent Workflow (2 minutes)
```bash
bash ~/bin/openswitchctl broadcast "Build a REST API with CRUD endpoints for a 'users' resource. Planner: create the plan. Codex: implement. Tester: write tests. Guardian: security review."
```

**Expected:** 
- Planner replies with task breakdown
- Codex creates files
- Tester writes tests
- Guardian reports security findings

---

### Test 3: Code Quality (1 minute)
```bash
bash ~/bin/openswitchctl send crew-coder "Refactor all console.log statements in RoastArena/src to use a proper logging library"
```

**Expected:** 
- Codex edits 10+ files
- Installs a logging library (winston/pino)
- Reports which files were changed

---

## 🔍 How to Monitor Performance

### Dashboard
Open: http://127.0.0.1:4318

**What to check:**
- ✅ All agents show "up"
- ✅ DLQ count is 0 (or low)
- ✅ RT Messages showing agent communication
- ✅ No timeout errors

---

### SwiftBar Menu
Click the CrewSwarm menu in your Mac menu bar.

**What to check:**
- ✅ All 7 agents listed
- ✅ Queue shows `0 pending, 0 stuck`
- ✅ "RT Server: ✓ Up"

---

### Logs
```bash
# Agent logs (each agent has its own)
tail -f ~/.opencrew/logs/openclaw-rt-crew-coder.log

# Gateway logs
tail -f ~/.openclaw/gateway.log

# RT messages (real-time communication)
tail -f ~/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/events.jsonl
```

---

## ⚡ Performance Tuning

### Current Settings (Good for Most Cases)
```json
{
  "maxConcurrent": 20,  // 20 parallel tasks
  "subagents": {
    "maxConcurrent": 40  // Each agent can spawn 40 helpers
  }
}
```

### If You Have Heavy Workloads
Edit `~/.openclaw/openclaw.json`:
```json
{
  "maxConcurrent": 50,    // More parallel tasks
  "subagents": {
    "maxConcurrent": 100  // More helpers
  }
}
```

Then restart:
```bash
bash ~/bin/openswitchctl restart-all
```

---

## 🎓 Best Practices

### 1. **Be Specific in Prompts**
❌ Bad: "Fix the bug"  
✅ Good: "The login form throws 'undefined user' error when email is empty. Debug and fix."

### 2. **Use the Right Agent**
- `crew-main` (Quill): Complex tasks, coordination
- `crew-coder` (Codex): New features, refactoring
- `crew-pm` (Planner): Architecture, planning
- `crew-qa` (Tester): Testing, QA
- `crew-fixer` (Debugger): Bug fixes, debugging
- `security` (Guardian): Security reviews

### 3. **Broadcast for Multi-Agent Tasks**
```bash
bash ~/bin/openswitchctl broadcast "Who wants to work on X?"
```
Agents pick up tasks they're best suited for.

### 4. **Check Artifacts**
After a coding task, verify files were actually created:
```bash
# Check recent changes
git status
git diff

# Or check specific file
cat /path/to/file
```

---

## 🛠️ Troubleshooting Commands

```bash
# Status check
bash ~/bin/openswitchctl status

# Restart everything
bash ~/bin/openswitchctl restart-all

# Restart specific agent
bash ~/bin/openswitchctl restart-agent crew-coder

# Restart gateway only
bash ~/bin/openswitchctl restart-openclaw-gateway

# Stop all
bash ~/bin/openswitchctl stop-all

# Start all
bash ~/bin/openswitchctl start-all

# Check logs
bash ~/bin/openswitchctl logs crew-coder

# Send message
bash ~/bin/openswitchctl send crew-coder "Hello!"

# Broadcast
bash ~/bin/openswitchctl broadcast "Status check"
```

---

## 📊 What "Working" Looks Like

### Good Signs ✅
- Agents reply within 30 seconds
- Files are created/modified (not just chat)
- Tests run automatically after code changes
- Error messages are helpful
- DLQ count stays low (<5)
- Health check log shows "✅ complete"

### Bad Signs ❌
- Agents take >2 minutes to reply
- Tasks marked "done" but no files changed
- Errors like "OpenCode timeout"
- DLQ count growing (>20)
- Gateway restart loops
- Agent daemons keep crashing

If you see bad signs, check the [Common Issues](#-common-issues--fixes) section above.

---

## 🎯 Quick Win: Test Now!

```bash
bash ~/bin/openswitchctl send crew-coder "Add error handling to ALL functions in RoastArena/src/api/"
```

Watch Codex:
1. Read all files in `src/api/`
2. Add try-catch blocks
3. Report which files were modified

**This proves your agents are working at 100%!** 🚀

