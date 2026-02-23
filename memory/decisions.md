# Decisions

Record durable choices here. Append new decisions at the top.

## Template

```
## [DEC-000] Title
- Date: YYYY-MM-DD HH:MM UTC
- Owner: agent-name-or-id
- Context: why this decision was needed
- Decision: what was chosen
- Impact: what this changes
- Revisit trigger: when to revisit this decision
```

## Entries

## [DEC-005] Enforce memory protocol marker at task execution boundaries
- Date: 2026-02-19 08:22 UTC
- Owner: opencode-gpt-5.3-codex
- Context: Future runtime entrypoints could call task executors without passing through `buildTaskPrompt`, which risks bypassing required startup/shutdown memory instructions.
- Decision: Add `assertTaskPromptProtocol` checks before OpenCode execution and gateway chat sends for direct and realtime task flows; fail with `MEMORY_PROTOCOL_MISSING` when the protocol block is absent.
- Impact: Task execution now has runtime guardrails against prompt-path drift, not just prompt-construction conventions.
- Revisit trigger: If task execution moves behind a dedicated orchestrator API that guarantees protocol injection.

## [DEC-004] Auto-bootstrap required memory files in gateway wrapper
- Date: 2026-02-19 08:19 UTC
- Owner: opencode-gpt-5.3-codex
- Context: Startup protocol required creating missing memory files from templates and halting on memory load failure, but wrapper behavior only reported missing files.
- Decision: Add wrapper-level auto-bootstrap for required `memory/` files, append a bootstrap assumption log entry, and fail closed with `MEMORY_LOAD_FAILED` when memory cannot load.
- Impact: Direct chat and realtime tasks now self-heal missing memory files and reliably stop on unrecoverable memory-load failures.
- Revisit trigger: If memory bootstrapping moves to a dedicated initialization service.

## [DEC-003] Centralize memory protocol prompt assembly in gateway wrapper
- Date: 2026-02-19 08:00 UTC
- Owner: crew-main
- Context: Direct chat and realtime task paths previously assembled prompts independently, risking drift in startup/shutdown memory instructions.
- Decision: Route both paths through `buildTaskPrompt` and inject one shared mandatory memory protocol block plus handoff timestamp context.
- Impact: All current gateway entrypoints apply the same memory checklist behavior before model execution.
- Revisit trigger: If prompt assembly moves to a dedicated orchestrator service.

## [DEC-002] Enforce memory hooks in wrapper and agent prompts
- Date: 2026-02-19 07:59 UTC
- Owner: crew-main
- Context: Startup hook location remained open and could cause context drift if only one layer enforced memory loading.
- Decision: Apply shared memory startup/shutdown requirements in both orchestration wrapper logic and agent system prompts.
- Impact: Tasks fail closed when memory cannot load, and every runtime path uses the same baseline context.
- Revisit trigger: If one enforcement layer proves redundant and telemetry shows 100% compliance for 30 days.

## [DEC-001] Use repo-based shared memory as canonical context
- Date: 2026-02-18 00:00 UTC
- Owner: bootstrap
- Context: Chat/session state is not guaranteed to persist across tool sessions.
- Decision: Store persistent context in versioned files under `memory/`.
- Impact: All agents can recover state by reading files at startup.
- Revisit trigger: If a dedicated memory service is adopted and proven reliable.
