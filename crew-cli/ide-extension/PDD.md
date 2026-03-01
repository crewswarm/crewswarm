# PDD: CrewSwarm VS Code IDE Integration

Date: 2026-03-01
Status: Draft for implementation

## 1. Product Summary

Build a branded VS Code extension that acts as a thin client to CrewSwarm runtime. The extension provides a chat-first interface, streams responses, and applies code changes via explicit diff approval.

## 2. Problem

Current CLI/TUI workflows are powerful but terminal-centric. Many developers want IDE-native interaction (chat panel, file-aware context, diff/apply) without duplicating orchestration logic in the editor.

## 3. Goals

1. IDE-native chat workflow using existing CrewSwarm `/v1/*` APIs.
2. Safe edit flow with explicit preview/apply.
3. Seamless connected and standalone runtime support.
4. Branded UX consistent with CrewSwarm identity.

## 4. Non-Goals (v1)

1. Re-implementing orchestration logic inside extension.
2. Full Copilot-style inline completion parity.
3. Automatic background refactors without user approval.

## 5. Target Users

1. Existing CrewSwarm users who prefer VS Code.
2. Teams using dashboard+gateway but wanting IDE execution path.
3. Power users running standalone local mode.

## 6. User Experience

### Primary flow

1. User opens CrewSwarm sidebar.
2. User asks in chat.
3. Extension sends prompt + selected context to `/v1/chat`.
4. Extension streams response in panel.
5. If patches/files returned, extension shows actionable cards.
6. User clicks `Preview` then `Apply`.

### Core UI elements

1. Activity bar icon + sidebar webview.
2. Chat transcript + input + mode indicator.
3. Action cards: patch/file/command.
4. Status bar: connection status + mode.

## 7. Functional Requirements

### MVP

1. Sidebar webview chat UI.
2. Backend client to `/v1/chat`.
3. Streaming support (SSE or chunked fallback).
4. Action parser for structured response payload.
5. Diff preview and apply for file edits.
6. Basic branding and status bar indicator.

### Production v1

1. Retry/backoff + reconnect UX.
2. Context chips for selection/current/open files.
3. Settings UI and persisted config.
4. Auth header support.
5. Structured telemetry/logging hooks.

### Nice-to-have

1. Context menu command: `Ask Crew`.
2. Trace panel via `/v1/traces/:traceId`.
3. Task timeline via `/v1/tasks`.

## 8. Technical Architecture

1. Extension Host (TypeScript): commands, settings, API client, patch apply.
2. Webview UI: chat rendering, input, action cards.
3. CrewSwarm Runtime: existing `/v1/*` endpoints in connected/standalone modes.

### Contract expectation (`/v1/chat`)

Request:

```json
{
  "message": "...",
  "sessionId": "...",
  "context": "...",
  "mode": "connected|standalone"
}
```

Response (recommended):

```json
{
  "reply": "...",
  "traceId": "...",
  "executionPath": ["l1-interface", "l2-orchestrator", "l3-executor-single"],
  "pendingChanges": 2,
  "patches": [
    { "path": "src/a.ts", "unifiedDiff": "diff --git ..." }
  ],
  "files": [
    { "path": "src/new.ts", "contents": "..." }
  ]
}
```

## 9. Safety and Trust

1. No auto-apply by default.
2. Always show preview before apply.
3. Log applied file paths and trace IDs.
4. If parse fails, never apply; show raw output.

## 10. Metrics

1. Time-to-first-response in panel.
2. Apply success rate for returned patches.
3. Revert/rollback rate after apply.
4. Connected vs standalone usage split.
5. Weekly active extension users.

## 11. Milestones

1. M1 (3-5 days): MVP complete.
2. M2 (7-10 days): production v1 quality.
3. M3 (+5-10 days): context actions + traces + timeline.

## 12. Open Questions

1. SSE vs websocket standard for streaming across both modes?
2. Unified patch schema source of truth (backend-enforced vs extension tolerant parser)?
3. Telemetry opt-in policy defaults?

## 13. Rollout Plan

1. Internal alpha with CrewSwarm core team.
2. Private beta with existing dashboard users.
3. Public release on VS Code marketplace + VSCodium docs.
