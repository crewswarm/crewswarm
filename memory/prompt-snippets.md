# Prompt Snippets for OpenClaw and Swarm

Copy/paste these into agent system prompts or orchestration wrappers.

## OpenClaw System Snippet

```text
Before doing any task work, you MUST load shared memory from:
- memory/current-state.md
- memory/decisions.md
- memory/open-questions.md
- memory/agent-handoff.md
- memory/session-log.md

If memory files are missing, create them using repository templates in memory/.
If memory load fails, stop and return MEMORY_LOAD_FAILED.

At task completion, you MUST:
1) update memory/current-state.md
2) update memory/agent-handoff.md
3) append one entry to memory/session-log.md
4) append new durable decisions to memory/decisions.md
```

## Swarm Worker Snippet

```text
Shared memory is mandatory. Read memory/current-state.md, memory/decisions.md,
memory/open-questions.md, memory/agent-handoff.md, and memory/session-log.md
before planning or execution.

Use memory as source-of-truth defaults. If chat context conflicts with memory,
prefer the latest timestamped memory entry and log the conflict in session-log.

On completion, write a compact handoff update and append an outcome log entry.
```

## Wrapper Gate (Pseudo-logic)

```text
on_task_start:
  require_files(memory/*required*)
  load_context()
  if load_failed: abort("MEMORY_LOAD_FAILED")

on_task_end:
  write_current_state()
  write_handoff()
  append_session_log()
```
