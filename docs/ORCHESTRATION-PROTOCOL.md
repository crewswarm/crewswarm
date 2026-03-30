# Orchestration Protocol

This document describes the stable coordination rules for CrewSwarm.

## Participants

Shared chat can coordinate:

- crewswarm agents such as `@crew-coder`, `@crew-qa`, `@crew-pm`
- CLI participants such as `@codex`, `@cursor`, `@claude`, `@opencode`, `@gemini`, `@crew-cli`

Not every participant has the same execution model, but they should follow the same coordination contract.

## Preferred Routing

1. User request enters through a surface such as Dashboard, Vibe, or API.
2. The surface provides explicit `projectId` and `projectDir` where available.
3. `crew-lead` or the selected engine resolves the task target.
4. If the task is a swarm task, it is dispatched over RT.
5. If the task is a direct engine task, it runs through the selected engine adapter.

## Engine Routing

Every task is routed to either a **CLI engine** (Claude Code, Cursor, Codex, Gemini CLI, etc.) or **direct-llm** (API chat completion). The decision is made by `isCodingTask()` in `lib/agents/dispatch.mjs` — a keyword match, not an LLM call.

**How it works:**
1. Task must be type `command.run_task`, `task.assigned`, or `task.reassigned` (chat messages always go direct-llm).
2. Status/heartbeat actions are filtered out.
3. The task prompt is scanned for coding keywords: `implement`, `build`, `create`, `fix`, `refactor`, `add`, `update`, `modify`, `code`, `function`, `class`, `component`, `api`, `endpoint`, `route`, `test`, `bug`, `error`, `issue`, `file`, `script`, `module`, `package`.
4. If **any keyword matches** → CLI engine (Claude Code, Cursor, Codex, etc. — native tool use, file I/O, shell access).
5. If **no keyword matches** → direct-llm (LLM API call with @@tool markers: @@WRITE_FILE, @@READ_FILE, @@RUN_CMD are executed by the system after the LLM responds).

**Both paths can write files**, but differently:
- CLI engines have native file I/O and shell access built into the CLI session.
- direct-llm agents write files via @@WRITE_FILE markers in their response text, which the system executes after the LLM call.

**Why routing still matters for dispatch:**
- CLI engines are better for complex multi-file coding tasks (full repo context, incremental edits, test runs).
- direct-llm is fine for single-file writes, research reports, and simple tasks.
- When crafting @@DISPATCH tasks for build agents, use verbs like "Create", "Build", "Implement", "Fix" to ensure CLI engine routing.
- The per-agent CLI engine is resolved from `crewswarm.json` flags (`useClaudeCode`, `useCursorCli`, `useCodex`, etc.) or the `engine` field.

## Dispatch Rules

- Use direct dispatch parsing for imperative commands when possible.
- Coordinators may emit dispatches; regular workers should not simulate dispatch in prose.
- A dispatch is only real if it produces a runtime event or task assignment, not merely a natural-language claim.
- Any agent result containing `@@DISPATCH` markers is parsed and dispatched by the system automatically.

## Pipeline Rules

- Tasks in the same wave run in parallel.
- Higher waves wait for lower waves to complete.
- Pipelines tied to a real project directory should preserve that project context across all waves.
- Quality gates should stop advancement by default unless explicitly configured otherwise.

## Project Rules

- Shared project history is the primary source of truth for a project.
- Engine-native sessions are secondary continuity aids, not the canonical project record.
- Surfaces must not silently drift to another project when sending a task.

## Verification Rules

- Prefer observable runtime status over inferred state.
- Verify dispatch, reply delivery, and project propagation with browser-backed tests where possible.
- When an engine or surface claims success, there should be a corresponding artifact, reply, or health signal.
