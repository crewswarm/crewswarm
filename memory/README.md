# Shared Memory System

This directory is the canonical, persistent memory for all OpenClaw crew agents.

## Goal

- Keep context across sessions and restarts.
- Make memory explicit, auditable, and human-readable.
- Ensure every agent loads the same baseline context before work.

## Required Files

- `memory/current-state.md`: Live project status, active work, and immediate next steps.
- `memory/decisions.md`: Decision log (ADR-lite) with rationale and impact.
- `memory/open-questions.md`: Unresolved questions and blocked items.
- `memory/agent-handoff.md`: Next-session handoff for fast restart.
- `memory/session-log.md`: Append-only task outcomes from all agents.
- `memory/orchestration-protocol.md`: PM's dispatch instructions.

**Note:** `gateway-bridge.mjs` injects 4 files per task: current-state, decisions, agent-handoff, orchestration-protocol (open-questions and session-log excluded for brevity).

## Agent Contract (Mandatory)

1. Startup: read all required files before doing task work.
2. Execution: use memory for defaults, decisions, and constraints.
3. Shutdown: write updates to `current-state.md`, `agent-handoff.md`, and append to `session-log.md`.
4. If startup memory load is skipped, the task is invalid and must stop.

## Write Rules

- Keep entries short and specific.
- Add timestamps in UTC (`YYYY-MM-DD HH:MM UTC`).
- Include agent name or ID on updates.
- Never delete historical decisions or session log entries; append instead.

## Suggested Flow

1. Read memory files.
2. Plan work.
3. Execute work.
4. Record outcomes and handoff.

See `memory/protocol.md` for copy/paste startup and shutdown checklists.
