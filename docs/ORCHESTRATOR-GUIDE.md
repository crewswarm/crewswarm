# 🚀 Orchestrator Guide

**Last Updated:** 2026-02-26

> **Preferred approach:** Use the **Chat tab** in the dashboard — type naturally, crew-lead dispatches to crew-pm and the right agents automatically. The CLI orchestrators below are for programmatic/scripted use.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues.

## What This Does

You give a requirement → PM plans → agents execute in parallel waves → verification → files on disk.

```
YOU: "Build user authentication"
  ↓
crew-pm: plans tasks
  ↓
├─→ crew-coder:    implements auth (wave 1)
├─→ crew-qa:       audits output  (wave 2)
└─→ crew-github:   commits to git (wave 3)

Result: Files written to disk ✓
```

## How to Use

### Basic Usage
```bash
node unified-orchestrator.mjs "Your requirement here"
# or
node scripts/run.mjs "Your requirement here"
```

### Examples

**Authentication System:**
```bash
node unified-orchestrator.mjs "Build JWT-based user authentication with login, register, and password reset"
```

**API Features:**
```bash
node unified-orchestrator.mjs "Create rate limiting middleware that blocks after 100 requests per minute"
```

**UI Components:**
```bash
node unified-orchestrator.mjs "Add dark mode toggle to dashboard with smooth transitions"
```

**Full Features:**
```bash
node unified-orchestrator.mjs "Build a notification system with email, SMS, and in-app alerts"
```

## What Happens (Behind the Scenes)

### 1. PM Receives Master Task
- PM analyzes your requirement
- Breaks it into subtasks
- Identifies dependencies

### 2. PM Dispatches to Agents (Parallel)
```
PM → Codex:    "Implement these 5 files"
PM → Tester:   "Write tests when Codex is done"
PM → Security: "Audit when Codex is done"
PM → PM:       "Research best practices now"
```

### 3. Agents Coordinate via RT Channels
```
Codex → Tester:   "Files ready: login.ts, register.ts"
Codex → Security: "Audit these files"
Tester → PM:      "38 tests pass, 94% coverage"
Security → PM:    "Security approved, 0 issues"
```

### 4. PM Reports Final Status
```
🎉 REQUIREMENT COMPLETE

✅ Research: JWT + bcrypt recommended
✅ Implementation: 5 files created
✅ Testing: 38 tests, 94% coverage
✅ Security: Audit passed
✅ Documentation: README + API docs
✅ UI/UX: Polished forms

Status: PRODUCTION READY ✓
```

## Output

### Files Created
All implemented files in your project:
- TypeScript with strict types
- JSDoc comments
- Proper error handling
- Production-ready

### Tests
Comprehensive test suite:
- Unit tests
- Integration tests
- Edge cases
- >90% coverage

### Documentation
Complete docs:
- README.md (setup + usage)
- API.md (endpoints + examples)
- SECURITY.md (considerations)

### Security
Full audit report:
- Vulnerability scan
- Dependency check (npm audit)
- Code review
- Approval status

## Pipeline Stages (Automatic)

| Stage | Agent | What Happens | Duration |
|-------|-------|--------------|----------|
| Research | PM | Searches best practices | 30s |
| Architecture | PM | Designs solution | 45s |
| Implementation | Codex | Writes code | 2-5min |
| Testing | Tester | Writes tests, runs them | 2-3min |
| Security | Guardian | Audits for vulnerabilities | 1-2min |
| Documentation | PM | Writes README, API docs | 1min |
| UI/UX | Codex | Polishes interface | 1-2min |
| Final Review | PM | Verifies everything | 30s |

**Total Time: 8-15 minutes** for a complete feature

## Monitoring Progress

The orchestrator shows live updates:
```
⏳ Monitoring swarm progress...

  ✓ Research complete
  ✓ Implementation complete
  ✓ Testing complete
  ✓ Security audit complete
  ✓ Documentation complete
  ✓ UI/UX complete

✅ PM reports: COMPLETE
```

## Troubleshooting

### "Timeout: Swarm did not complete"
**Cause:** Pipeline took >10 minutes (usually means an agent got stuck)

**Fix:**
```bash
# Check which agent is stuck
bash scripts/openswitchctl status   # or ~/bin/openswitchctl if installed

# Check errors (default path; overridden by SHARED_MEMORY_DIR)
tail -50 ~/.crewswarm/workspace/shared-memory/claw-swarm/opencrew-rt/channels/issues.jsonl

# Restart stuck agent
bash scripts/openswitchctl restart-agent crew-coder
```

### "PM not dispatching tasks"
**Cause:** PM is waiting for instructions instead of acting autonomously

**Fix:**
Handled by external unified orchestrator (`unified-orchestrator.mjs`)

### "Agents not communicating"
**Cause:** RT channels not working or agents not using correct message format

**Fix:**
```bash
# Check crew-lead (port 5010)
curl http://127.0.0.1:5010/health

# Check agent status
npm run health
```

### "Code quality is poor"
**Cause:** Validation is disabled or agents using wrong model

**Fix:**
```bash
# Check agent models
grep '"model":' ~/.crewswarm/crewswarm.json | head -7

# Should all be: groq/llama-3.3-70b-versatile
```

## Advanced Usage

### Custom Pipeline Stages
Edit `unified-orchestrator.mjs` and modify the PM/parser prompts to add your own stages:
```javascript
- @custom-agent: Custom task description
```

### Parallel vs Sequential
By default, tasks run in parallel where possible:
- Research + Architecture run first (parallel)
- Implementation starts after architecture
- Testing + Security + UI/UX run in parallel after implementation
- Documentation runs after testing + security
- Final review runs last

### Adjust Timeout
Default timeout is 10 minutes. To increase:
```javascript
// In unified-orchestrator.mjs (adjust timeout in gateway-bridge runSendToAgent if needed)
const finalReport = await monitorProgress(response.taskId, 900000); // 15 min
```

## Best Practices

### 1. Be Specific
❌ Bad: "Build auth"  
✅ Good: "Build JWT-based authentication with login, register, logout, and password reset endpoints"

### 2. Include Context
❌ Bad: "Add dark mode"  
✅ Good: "Add dark mode toggle to dashboard with smooth CSS transitions and persistent localStorage"

### 3. Mention File Paths
❌ Bad: "Create API"  
✅ Good: "Create REST API in /api/users/ with CRUD endpoints"

### 4. Specify Tech Stack
❌ Bad: "Build form"  
✅ Good: "Build React form with Zod validation and TypeScript types"

## Real-World Examples

### E-commerce Feature
```bash
node unified-orchestrator.mjs "Build shopping cart with add/remove items, calculate total with tax, persist to localStorage, and show item count badge in navbar"
```

**Output:**
- `components/ShoppingCart.tsx` (cart UI)
- `lib/cart.ts` (cart logic)
- `hooks/useCart.ts` (React hook)
- `tests/cart.test.ts` (28 tests)
- Security audit (XSS prevention)
- README with usage examples

### Dashboard Widget
```bash
node unified-orchestrator.mjs "Create analytics dashboard widget showing user signups over last 7 days with line chart using Recharts"
```

**Output:**
- `components/SignupChart.tsx` (chart component)
- `lib/analytics.ts` (data fetching)
- `api/analytics/signups.ts` (API endpoint)
- `tests/analytics.test.ts` (15 tests)
- Responsive design (mobile-friendly)
- Documentation with screenshots

### Background Job System
```bash
node unified-orchestrator.mjs "Build background job queue using BullMQ with Redis, support retries, job scheduling, and web UI to monitor jobs"
```

**Output:**
- `lib/queue/index.ts` (queue setup)
- `lib/queue/jobs/*.ts` (job definitions)
- `api/jobs/route.ts` (monitoring API)
- `components/JobMonitor.tsx` (UI)
- `tests/queue.test.ts` (32 tests)
- Security audit (Redis auth)
- Deployment guide

## Comparison: Before vs After

### Before (Manual Assignment)
```
You: "Build auth"
You: "Use JWT"
You: "Add bcrypt for passwords"
You: "Create login endpoint"
You: "Create register endpoint"
You: "Add validation"
You: "Write tests"
You: "Check for SQL injection"
You: "Write docs"
You: "Make the form pretty"
You: "Why isn't this working?"

Time: 2 hours of micromanaging
Quality: Inconsistent
```

### After (Autonomous Orchestrator)
```
You: "Build JWT auth with login/register"

[Wait 10 minutes]

PM: "Done. 8 files. 42 tests. 0 vulnerabilities. Production ready."

Time: 10 minutes, zero micromanaging
Quality: Perfect, tested, documented, secure
```

## That's It!

**Now you can bark orders and get perfect code.** 🚀

Test it:
```bash
node unified-orchestrator.mjs "Create a simple todo list API with CRUD operations"
```

Watch the swarm work its magic!

