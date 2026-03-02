# Unified Interface API (v1)

This spec defines one API contract for two runtime modes:

1. `connected` — dashboard/clients call CrewSwarm (`crew-lead` + gateway/RT).
2. `standalone` — dashboard/clients call local `crew-cli` runtime directly.

Goal: the UI/clients do not care which backend mode is active.

Versioned machine-readable contract:

- `docs/openapi.unified.v1.json`

## Modes

### Connected Mode

- Primary for CrewSwarm dashboard.
- Backed by one-level-up services (`crew-lead`, `gateway-bridge`, RT bus).
- Existing endpoints/protocols remain source-of-truth:
  - `/chat`
  - `/api/dispatch`
  - `/api/status/:taskId`
  - `/api/agents`

### Standalone Mode

- Primary for local/power-user CLI and offline execution.
- Backed by local `crew-cli` runtime (`Orchestrator`, `UnifiedPipeline`, `Sandbox`, `SessionManager`).
- Served through a local HTTP adapter (recommended command: `crew serve`).

## Runtime Selection

Use one selector for all interfaces:

- `CREW_INTERFACE_MODE=connected|standalone`

Optional:

- `CREW_LEAD_URL=http://127.0.0.1:5010` (connected)
- `CREW_API_PORT=4317` (standalone local API)

## Unified Endpoints

All responses are JSON.

### 1) Chat

`POST /v1/chat`

Request:
```json
{
  "message": "build auth API with tests",
  "sessionId": "user-123",
  "context": {
    "files": ["src/auth.ts"],
    "docs": true
  },
  "images": [],
  "mode": "assist"
}
```

Response:
```json
{
  "reply": "Done. Created auth API and tests in sandbox.",
  "traceId": "pipeline-abc",
  "executionPath": ["l1-interface", "l2-orchestrator", "l3-executor-single"],
  "costUsd": 0.0132,
  "pendingChanges": 3
}
```

### 2) Dispatch Task

`POST /v1/tasks`

Request:
```json
{
  "agent": "crew-coder",
  "task": "refactor auth middleware",
  "sessionId": "user-123",
  "options": {
    "model": "deepseek-chat",
    "engine": "codex"
  }
}
```

Response:
```json
{
  "accepted": true,
  "taskId": "task-xyz"
}
```

### 3) Task Status

`GET /v1/tasks/:taskId`

Response:
```json
{
  "status": "done",
  "result": "task output...",
  "traceId": "pipeline-abc",
  "costUsd": 0.021
}
```

### 4) Agent List

`GET /v1/agents`

Response:
```json
{
  "agents": [
    { "id": "crew-coder", "status": "online", "model": "..." }
  ]
}
```

### 5) System Status

`GET /v1/status`

Response:
```json
{
  "mode": "connected",
  "gateway": "ok",
  "l2": {
    "unifiedRouter": true,
    "dualL2": true
  },
  "queueDepth": 0,
  "pipeline": {
    "runs": 12,
    "qaApproved": 10,
    "qaRejected": 2,
    "qaRoundsAvg": 1.4,
    "contextChunksUsed": 184,
    "contextCharsSavedEst": 91234
  }
}
```

### 6) Sandbox Preview

`GET /v1/sandbox`

Response:
```json
{
  "branch": "main",
  "changedFiles": 2,
  "diffPreview": "..."
}
```

### 7) Sandbox Apply

`POST /v1/sandbox/apply`

Request:
```json
{
  "branch": "main",
  "checkCommand": "npm test"
}
```

Response:
```json
{
  "success": true,
  "appliedFiles": ["src/auth.ts", "tests/auth.test.ts"]
}
```

### 8) Sandbox Rollback

`POST /v1/sandbox/rollback`

Request:
```json
{ "branch": "main" }
```

Response:
```json
{ "success": true }
```

### 9) Trace Lookup

`GET /v1/traces/:traceId`

Response:
```json
{
  "composedPrompts": [],
  "plannerTrace": [],
  "events": []
}
```

### 10) Index Rebuild

`POST /v1/index/rebuild`

Request:
```json
{
  "paths": ["docs", "src"],
  "includeDocs": true,
  "includeCode": true
}
```

Response:
```json
{
  "indexId": "idx-001",
  "stats": { "files": 320, "chunks": 2400 }
}
```

### 11) Index Search

`GET /v1/index/search?q=auth+token`

Response:
```json
{
  "hits": [
    { "path": "src/auth/token.ts", "score": 0.92, "snippet": "..." }
  ]
}
```

## UI Contract (Dashboard-First)

For the primary dashboard UX, the backend should always expose:

- run state ribbon: `L1 -> L2 -> L3`
- `traceId` on every non-trivial execution
- diff preview before filesystem writes
- clickable diagnostics with file/line references

## CLI Contract (Standalone/Power)

CLI should remain equivalent to API calls:

- `crew chat` -> `/v1/chat`
- `crew dispatch` -> `/v1/tasks`
- `crew preview/apply/rollback` -> `/v1/sandbox*`
- `crew trace <id>` -> `/v1/traces/:traceId`

## Compatibility Notes

- Current connected stack already supports the core primitives via `crew-lead` endpoints.
- `standalone` mode should provide the same shapes via a local adapter layer.
- Keep response envelopes stable to avoid dashboard/CLI drift.
