# `crew-lead.mjs` Split Plan (Codex)

## Goals
- Reduce `crew-lead.mjs` blast radius for changes.
- Isolate side effects (HTTP, SSE, RT, storage, process control).
- Make command parsing and orchestration testable without booting services.
- Keep runtime behavior unchanged during extraction.

## Target Module Map
- `lib/lead/http-server.mjs`
  - Express/app wiring, routes, SSE endpoint registration, middleware.
- `lib/lead/chat-controller.mjs`
  - `/api/crew-lead/chat`, `/history`, `/clear`, context warnings, fallback model flow.
- `lib/lead/events-bus.mjs`
  - In-process pub/sub for UI events (`chat_message`, `agent_reply`, `pipeline_progress`, etc.).
- `lib/lead/command-parser.mjs`
  - `@@` command parsing, normalization, validation, typed command objects.
- `lib/lead/command-router.mjs`
  - Dispatch typed commands to handlers (dispatch, pipeline, service, skill, project, brain).
- `lib/lead/pipeline-runner.mjs`
  - Wave execution, retries, quality gates, completion events.
- `lib/lead/project-manager.mjs`
  - project draft/create/confirm/discard, roadmap file ops, PM-loop hooks.
- `lib/lead/skills-runner.mjs`
  - skill loading/lookup/aliases/param normalization/approval gate.
- `lib/lead/agent-registry.mjs`
  - canonical IDs, aliases, liveness snapshot, model metadata.
- `lib/lead/background-loop.mjs`
  - background consciousness scheduler and guardrails.
- `lib/lead/persistence.mjs`
  - session/history read-write, token usage stats, pending approvals state.
- `lib/lead/config.mjs`
  - env/config resolution with defaults and validation.
- `lib/lead/index.mjs`
  - composition root: construct dependencies and start services.

## Extraction Order (Safe Sequence)
1. `events-bus` + `config` + `persistence` (low coupling).
2. `command-parser` (pure, no side effects) with fixture tests.
3. `skills-runner` + `agent-registry`.
4. `pipeline-runner` (inject dispatch + event emitter).
5. `project-manager` (inject FS + PM-loop launcher).
6. `chat-controller` (inject parser/router/history/events).
7. `http-server` route wiring.
8. `background-loop`.
9. Shrink `crew-lead.mjs` into bootstrap that imports `lib/lead/index.mjs`.

## Interfaces To Define First
- `LeadEvents.emit(type, payload)` / `LeadEvents.subscribe(fn)`.
- `CommandParser.parse(input) -> { kind, args, raw }`.
- `CommandRouter.run(cmd, ctx) -> { ok, reply?, dispatched?, events? }`.
- `HistoryStore.{load,append,clear}(sessionId)`.
- `PipelineRunner.run(spec, ctx)`.
- `ProjectManager.{draft,confirm,discard,list,update}`.

## Test Plan Per Stage
- Parser: golden tests for all `@@` commands and malformed inputs.
- Router: mocked dependencies, assert selected handler + output contract.
- Pipeline: deterministic wave fixtures (success/fail/retry/timeout).
- Chat controller: dedupe behavior, fallback behavior, SSE event shape.
- Integration: smoke route tests against composed server.

## Risk Controls
- Keep old and new path behind `CREWSWARM_LEAD_SPLIT=1` flag until parity.
- Add event-shape contract snapshots for dashboard consumers.
- Preserve exact API payload keys and status codes.
- Migrate one route group at a time, with A/B fallback to legacy handler.

## Done Criteria
- `crew-lead.mjs` <= 400 lines, mostly bootstrap.
- No route/payload regressions in dashboard/API smoke checks.
- Parser + router + pipeline tests pass in CI.
- Background loop and PM-loop behavior unchanged from operator perspective.
