# IDE Integration Roadmap (VS Code First)

Date: 2026-03-01
Owner: CrewSwarm
Scope: Branded VS Code extension as a thin client to CrewSwarm `/v1/*` runtime.

## Principles

1. One backend contract: `/v1/*` only.
2. No orchestration logic inside extension.
3. No auto-apply by default.
4. Connected and standalone must both work.

## Phase 1: MVP (3-5 days)

### Goals

1. VS Code sidebar chat panel.
2. Connect to existing `POST /v1/chat`.
3. Stream responses to panel.
4. Show returned patch/file actions.
5. Apply changes button (manual apply only).
6. Basic branding (name, icon, webview colors, status bar item).

### Tasks

1. Create extension scaffold (`crew-vscode`) and command contributions.
2. Add webview chat UI with message bridge (`extension <-> webview`).
3. Implement API client for `/v1/chat` with optional streaming.
4. Parse structured actions (`patches`, `files`, `commands`) from response.
5. Implement diff preview and apply flow via `WorkspaceEdit` / diff docs.
6. Add status bar item (`Crew: connected|standalone`).

### Acceptance Criteria

1. User can send message and get streamed response.
2. If response includes changes, extension shows actionable list.
3. User can preview and apply at least one file patch.
4. No file is modified without explicit user action.
5. Branding visible in Activity Bar + panel + status bar.

## Phase 2: Production v1 (7-10 days)

### Goals

1. Robust error/reconnect/auth behavior.
2. Context chips (selection/current file/open files).
3. Better diff UX.
4. Settings page (backend URL, mode, token).
5. Telemetry/log hooks + packaging polish.

### Tasks

1. Add request retry/backoff and clear network error states.
2. Add auth handling (Bearer token / headers).
3. Context collector with explicit toggles/chips.
4. Improve diff rendering and conflict messaging.
5. Add extension settings:
   - `crewswarm.backendUrl`
   - `crewswarm.mode` (`connected|standalone`)
   - `crewswarm.authToken`
6. Add structured logs and optional telemetry events.
7. Build release pipeline (`vsce package`, versioning, changelog).

### Acceptance Criteria

1. Extension survives temporary backend disconnect and recovers.
2. User can switch connected/standalone without reinstall.
3. Context chips are visible and controllable before send.
4. Diff/apply flow is reliable across multi-file edits.
5. Extension package installs cleanly on VS Code + VSCodium.

## Phase 3: Nice-to-Have (5-10 days)

### Goals

1. Inline code actions / right-click “Ask Crew”.
2. Trace panel and task timeline.
3. Rich diagnostics integration.

### Tasks

1. Register editor context menu commands.
2. Add code actions and command bindings.
3. Add trace view backed by `GET /v1/traces/:traceId`.
4. Add task timeline UI from `/v1/tasks` polling/stream.
5. Integrate VS Code diagnostics into sent context and responses.

### Acceptance Criteria

1. User can invoke Crew from editor context menu.
2. Trace IDs open a readable trace panel.
3. Timeline shows task status transitions.
4. Diagnostics can be included in chat context on demand.

## Delivery Order

1. VS Code extension first.
2. VSCodium validation in same phase (same API).
3. Neovim adapter after v1 stabilizes.
4. Theia integration after extension metrics validate demand.

## Risks

1. Streaming differences between standalone and connected runtimes.
2. Patch schema inconsistency from model responses.
3. Auth/token misconfiguration causing poor first-run UX.

## Risk Mitigations

1. Contract tests for `/v1/chat` response/action schema.
2. Fail-safe: if patch parse fails, show raw response and do not apply.
3. `Connection Test` action in extension settings panel.
