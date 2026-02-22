# Startup and Shutdown Protocol

This protocol is mandatory for OpenClaw and all crew agents.

## Startup Checklist (Required)

1. Read the following files in order:
   - `memory/current-state.md`
   - `memory/decisions.md`
   - `memory/open-questions.md`
   - `memory/agent-handoff.md`
   - `memory/session-log.md`
2. Emit a short "memory loaded" note in your first response:
   - include timestamp and last handoff timestamp
3. If any file is missing or unreadable:
   - create it from template if absent
   - log assumption in `memory/session-log.md`
4. If startup load fails, stop task execution and return `MEMORY_LOAD_FAILED`.

## During Task

- Record durable choices in `memory/decisions.md`.
- Record unanswered blockers in `memory/open-questions.md`.
- Keep all changes timestamped and attributed.

### Coding Task Output Requirements

**If your task involves code changes (implement, fix, build, refactor, add, update, modify):**

1. **Your reply MUST include:**
   - List of files changed/created (with paths)
   - Summary of what changed in each file
   - Test results (if tests were run)
   - Any errors encountered and how they were resolved

2. **Required artifacts:**
   - Code diffs or file contents
   - Command outputs (build, test, lint)
   - Verification steps taken

3. **NEVER reply with only:**
   - "I updated the file" (without showing what changed)
   - "Done" or "Completed" (without evidence)
   - Suggestions without implementation
   - Plans without execution

4. **Format example:**
```
Files changed:
- src/utils/auth.ts (added validateToken function)
- src/api/login.ts (integrated token validation)

Tests run:
- npm test auth.test.ts → PASS (3/3)

Verification:
- Linter clean
- Build successful
```

5. **If you cannot complete the task:**
   - State why clearly
   - List what's blocking you
   - Suggest next steps

## Shutdown Checklist (Required)

1. Update `memory/current-state.md`:
   - project snapshot
   - in-progress status
   - next steps
2. Update `memory/agent-handoff.md`:
   - what just happened
   - current truth
   - next best action
   - risks
3. Append one entry to `memory/session-log.md`.
4. If decisions were made, append them to `memory/decisions.md`.
5. If open questions were resolved, mark status and move outcome to session log.

## Conflict Handling

- Prefer append-only writes for logs.
- For overwrite files (`current-state.md`, `agent-handoff.md`), include `Last updated` metadata.
- If parallel agents race, latest timestamp wins and both entries are preserved in `session-log.md`.
