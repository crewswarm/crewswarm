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

## Dispatch Rules

- Use direct dispatch parsing for imperative commands when possible.
- Coordinators may emit dispatches; regular workers should not simulate dispatch in prose.
- A dispatch is only real if it produces a runtime event or task assignment, not merely a natural-language claim.

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
