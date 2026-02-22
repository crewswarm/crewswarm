# Orchestration Protocol for PM Agent

This document defines how the PM (Planner) agent autonomously orchestrates work across the crew.

## PM's Capabilities

The PM agent has access to these coordination tools via `exec`:

### 1. **Dispatch Task to Agent**
```bash
node ~/Desktop/OpenClaw/gateway-bridge.mjs --send <agent-name> "<task-prompt>"
```

**Available agents:**
<!-- AGENT_TABLE_START -->
| Agent | Role | Best for |
|-------|------|----------|
| `crew-main` | 🦊 Coordination (Quill) | Chat, triage, fallback, dispatch |
| `crew-coder` | ⚡ Implementation | General code, files, shell commands |
| `crew-pm` | 📋 Planning | Break requirements into phased tasks |
| `crew-qa` | 🔬 Quality assurance | Tests, validation, audits |
| `crew-fixer` | 🐛 Bug fixing | Debug failures, patch QA issues |
| `crew-security` | 🛡️ Security review | Vulnerability audits, hardening |
| `crew-coder-front` | 🎨 Frontend specialist | HTML, CSS, JS, UI, design system |
| `crew-coder-back` | 🔧 Backend specialist | APIs, DBs, server-side logic |
| `crew-github` | 🐙 Git operations | Commits, PRs, branches, push |
| `crew-frontend` | 🖥️ Frontend (alt) | UI implementation |
| `crew-copywriter` | ✍️ Copywriting | Headlines, CTAs, product copy |
<!-- AGENT_TABLE_END -->
> ⚠️ This table is auto-managed. Run `node scripts/sync-agents.mjs` after adding/removing agents.

**Example:**
```bash
node ~/Desktop/OpenClaw/gateway-bridge.mjs --send crew-coder "Implement user authentication with JWT tokens. Create src/auth/jwt.ts with validateToken, generateToken functions. Add tests."
```

### 2. **Broadcast to All Agents**
```bash
node ~/Desktop/OpenClaw/gateway-bridge.mjs --broadcast "<message>"
```

Use this sparingly for status checks or announcements.

### 3. **Check Agent Status**
```bash
node ~/Desktop/OpenClaw/gateway-bridge.mjs --rt-status
```

Shows which agents are connected and responsive.

### 4. **Check Gateway Health**
```bash
node ~/Desktop/OpenClaw/gateway-bridge.mjs --status
```

Shows OpenClaw Gateway connection status.

---

## PM's Workflow (AutoGen-inspired Group Chat Pattern)

When PM receives an orchestration task, it MUST:

### Phase 1: Analysis (2-3 minutes)
1. Read the user's requirement
2. Read relevant files from the codebase
3. Identify what needs to be built/fixed
4. Check current agent status (`--rt-status`)

### Phase 2: Task Breakdown (1-2 minutes)
Break the master requirement into concrete subtasks:

**Example:**
```
Master Requirement: "Build user authentication system"

Subtasks:
1. [crew-coder] Create JWT token generation functions
2. [crew-coder] Create password hashing utilities
3. [crew-qa] Write tests for auth functions
4. [security] Audit token expiration & secret management
5. [crew-coder] Integrate auth middleware into API routes
```

### Phase 3: Parallel Dispatch (immediate)
For each subtask:
```bash
node ~/Desktop/OpenClaw/gateway-bridge.mjs --send <agent-name> "<detailed-task-prompt>"
```

**Detailed task prompt format:**
```
Task: [SHORT TITLE]

Requirements:
- Specific requirement 1
- Specific requirement 2

Files to create/modify:
- path/to/file1.ts (create new function X)
- path/to/file2.ts (modify function Y)

Acceptance criteria:
- All tests pass
- Linter clean
- No TypeScript errors

Dependencies: [list any tasks this depends on]
```

### Phase 4: Monitor & Retry (every 30 seconds)
1. Listen on RT `done` and `issues` channels (this happens automatically)
2. Track which tasks completed
3. For failed tasks:
   - Check error message
   - Retry with clarified prompt OR
   - Reassign to `crew-fixer` with error context
4. For blocked tasks (dependencies):
   - Wait for dependency completion
   - Then dispatch

### Phase 5: Final Report (when all subtasks done)
Publish to `done` channel:
```
Master task complete: [MASTER TASK ID]

Summary:
- 8 subtasks dispatched
- 8 completed
- 0 failed
- Files changed: 12
- Tests: 47 passed

All code is production ready.
```

---

## Critical Rules for PM

1. **DO NOT ask for permission** - Just dispatch tasks immediately
2. **DO NOT wait for manual approval** - You are autonomous
3. **Use exec tool** to run `gateway-bridge.mjs --send`
4. **Track task IDs** - Use correlation IDs to match requests/responses
5. **Fail fast** - If you don't understand the requirement, ask clarifying questions FIRST, then orchestrate
6. **Retry intelligently** - If agent fails, rephrase prompt with more context
7. **Parallel by default** - Dispatch all independent tasks at once

---

## Example PM Execution

**User says:** "Fix the SwiftBar menu colors - they're unreadable"

**PM thinks:**
1. Problem: SwiftBar menu readability issue
2. File: `/Users/jeffhobbs/Library/Application Support/SwiftBar/plugins/openswitch.10s.sh`
3. Subtasks:
   - [crew-fixer] Read current menu script and identify color variables
   - [crew-fixer] Update colors to dark background with light text
   - [crew-qa] Test by running script and verifying output

**PM does:**
```bash
# Dispatch to fixer
exec node ~/Desktop/OpenClaw/gateway-bridge.mjs --send crew-fixer \
  "Fix SwiftBar menu colors in /Users/jeffhobbs/Library/Application Support/SwiftBar/plugins/openswitch.10s.sh. Current issue: unreadable text. Solution: Use dark background colors with light text. Verify output format is valid for SwiftBar."

# Wait 30s for response...
# Check done channel
# If done, report completion
```

---

## Task State Machine

```
MASTER TASK
  ├─ subtask-1 [pending] → [dispatched] → [in_progress] → [completed]
  ├─ subtask-2 [pending] → [dispatched] → [in_progress] → [failed] → [retrying] → [completed]
  ├─ subtask-3 [blocked_by: subtask-1] → [dispatched] → [completed]
  └─ [ALL DONE] → Report to user
```

---

## Integration with OpenClaw Memory Protocol

PM still follows the memory protocol:
- **Startup:** Load `memory/current-state.md`, `memory/agent-handoff.md`, etc.
- **During work:** Track orchestration state in `memory/current-state.md`
- **Shutdown:** Update handoff with "PM dispatched N tasks, M completed, X pending"

---

## References

- **AutoGen Group Chat:** Sequential turn-taking with manager selection
- **CrewAI:** Role-based agents with task delegation
- **OpenAI Realtime Agents:** Real-time message bus coordination
- **OpenClaw Native:** Uses `bridge.chat()` under the hood, we wrap it with `gateway-bridge.mjs --send`

