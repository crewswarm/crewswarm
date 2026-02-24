# CrewSwarm — Ops Telemetry Schema

**Last Updated:** 2026-02-23

---

## Purpose

CrewSwarm now emits operations telemetry so the dashboard, CLI, and automation can all share a single view of system health. This document defines the canonical schema for every event and the event types required for day-to-day operations: `agent.presence`, `task.lifecycle`, and `error`. Each section describes the versioning rules, required fields, and JSON examples the dashboard must accept without additional mapping.

Telemetry goals:

- Real-time detection of agent outages or degraded performance
- End-to-end visibility of task dispatch, execution, retries, and escalations
- Centralized error triage with enough context to replay or escalate tasks quickly

---

## Event Envelope & Versioning

All telemetry events share a common envelope before the type-specific `data` payload. Events are persisted as JSON lines (for example `events.jsonl`) and streamed to subscribers (dashboard SSE, CLI tails, log shipping). The envelope allows new event types to coexist while guaranteeing stable identifiers for correlation.

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | string (`<major>.<minor>`) | ✅ | Semantic version of the schema used when encoding the event. Increment major for breaking envelope changes; increment minor for additive fields. |
| `eventType` | string | ✅ | Namespaced event name such as `agent.presence`, `task.lifecycle`, or `error`. |
| `eventId` | string (ULID/UUID) | ✅ | Globally unique identifier for deduplication. |
| `occurredAt` | ISO 8601 string | ✅ | Time the event originated at the component. |
| `receivedAt` | ISO 8601 string | Optional | Time the RT daemon ingested the event (helps identify clock skew). |
| `source` | object | ✅ | `{ "component": "gateway-bridge", "agentId": "crew-coder", "hostname": "hobbs-mbp", "pid": 4312 }`. `agentId` is optional for system-level events. |
| `correlationId` | string | ✅ | Stable ID for linking related events (e.g., `task:<taskId>`, `agent:<agentId>`). |
| `sessionId` | string | Optional | User session or chat channel associated with the event. |
| `initiator` | object | Optional | When triggered by a human or automation (`{ "type": "user", "id": "dashboard:jeff" }`). |
| `tags` | object (string map) | Optional | Flat metadata for indexing (`{"severity":"warn","env":"local"}`). |
| `data` | object | ✅ | Event-type specific payload described below. |

### Versioning Strategy

- **Schema version** is semver-like `<major>.<minor>`. Consumers MUST reject events with a higher major than they support and MAY warn on higher minor versions (fields can be ignored safely).
- Every producer includes `minCompatibleVersion` in configuration. Dashboards display a banner if `schemaVersion.major` exceeds their supported major.
- Additive fields are optional until all consumers enforce them. When a field transitions to required, increment the minor version until every consumer upgrades, then bump the major to deprecate the old path.
- Event types share the same envelope version. Type-specific payloads add their own `payloadVersion` only if the type needs additional stability guarantees.

---

## Event Types

### agent.presence

Heartbeat or state transition emitted by each `gateway-bridge` (and optionally crew-lead) every 30 seconds or on state change. Used to drive the agent status list, auto-restart alerts, and uptime metrics.

`data` fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | enum (`online`, `offline`, `degraded`, `draining`) | ✅ | `draining` → finishing tasks before restart. |
| `latencyMs` | integer | ✅ | Rolling average RTT to the RT bus or provider. |
| `uptimeSeconds` | integer | ✅ | Seconds since the agent process started. |
| `queueDepth` | integer | Optional | Pending tasks for the agent (0 if idle). |
| `lastTaskId` | string | Optional | Helps show “currently running” on dashboards. |
| `heartbeatSeq` | integer | ✅ | Monotonic counter for missed-heartbeat detection. |
| `capabilities` | array | Optional | Tool permissions and allowed skills. |
| `version` | string | ✅ | Git SHA or package version of the running agent binary. |

**Example:**

```json
{
  "schemaVersion": "1.1",
  "eventType": "agent.presence",
  "eventId": "evt_01HRQF4Y4T8A1X3J3K74X0DR0S",
  "occurredAt": "2026-02-23T21:40:12.981Z",
  "receivedAt": "2026-02-23T21:40:13.006Z",
  "source": {"component": "gateway-bridge", "agentId": "crew-coder-back", "hostname": "hobbs-mbp"},
  "correlationId": "agent:crew-coder-back",
  "tags": {"env": "local"},
  "data": {
    "status": "online",
    "latencyMs": 412,
    "uptimeSeconds": 88412,
    "queueDepth": 0,
    "lastTaskId": "task_0192ES9V6F2QA5",
    "heartbeatSeq": 1726,
    "capabilities": ["write_file", "run_cmd"],
    "version": "14d2b8b"
  }
}
```

### task.lifecycle

Sent whenever a task transitions between phases: `dispatched`, `accepted`, `started`, `needs_approval`, `approved`, `rejected`, `awaiting_input`, `completed`, `failed`, `escalated`, `cancelled`. Each transition overwrites the dashboard timeline while preserving historical records for audit.

`data` fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `taskId` | string | ✅ | Matches RT bus lease ID. |
| `agentId` | string | ✅ | Assigned agent for this phase. |
| `taskType` | string | ✅ | Short label (`"code"`, `"qa"`, etc.). |
| `phase` | enum | ✅ | One of the phases above. |
| `phaseOrdinal` | integer | ✅ | Incrementing counter to allow ordering even when timestamps tie. |
| `durationMs` | integer | Optional | Time spent completing the just-finished phase. |
| `result` | object | Optional | `{ "summary": "wrote src/auth.ts", "artifacts": ["src/auth.ts"] }`. Present on `completed`. |
| `error` | object | Optional | `{ "code": "LLM_TIMEOUT", "message": "Anthropic call exceeded 60s", "retryCount": 1 }`. Present on `failed`. |
| `retryStrategy` | object | Optional | Contains `attempt`, `maxAttempts`, `nextDelayMs`. |
| `dispatcher` | object | Optional | `{ "agent": "crew-main", "sessionId": "dashboard-123" }`. |

**Example:**

```json
{
  "schemaVersion": "1.1",
  "eventType": "task.lifecycle",
  "eventId": "evt_01HRQF7FQM0H1J20AR6C1MGY6D",
  "occurredAt": "2026-02-23T21:43:01.219Z",
  "source": {"component": "gateway-bridge", "agentId": "crew-coder"},
  "correlationId": "task:task_0192ES9V6F2QA5",
  "data": {
    "taskId": "task_0192ES9V6F2QA5",
    "agentId": "crew-coder",
    "taskType": "code",
    "phase": "completed",
    "phaseOrdinal": 4,
    "durationMs": 45781,
    "result": {
      "summary": "Implemented login endpoint",
      "artifacts": ["src/auth.ts"],
      "tokensUsed": {"prompt": 1821, "completion": 684}
    },
    "retryStrategy": {"attempt": 1, "maxAttempts": 3, "nextDelayMs": null}
  }
}
```

### error

Emitted whenever a component detects an unexpected condition that requires operator attention. Errors reference the task or agent when possible and feed both the dashboard alert tray and `crew-fixer` automations.

`data` fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `component` | string | ✅ | Logical component where the failure occurred (`"crew-lead"`, `"rt-bus"`, `"gateway-bridge"`). |
| `severity` | enum (`info`, `warn`, `error`, `critical`) | ✅ | Drives alert routing. |
| `errorCode` | string | ✅ | Stable identifier (e.g., `LLM_TIMEOUT`, `CMD_REJECTED`). |
| `message` | string | ✅ | Human-readable summary. |
| `stack` | string | Optional | Stack trace or serialized error. |
| `taskId` | string | Optional | Associates the error with a task lifecycle. |
| `agentId` | string | Optional | Agent impacted by the error. |
| `context` | object | Optional | Arbitrary data specific to the failure (HTTP status, command, provider name). |

**Example:**

```json
{
  "schemaVersion": "1.1",
  "eventType": "error",
  "eventId": "evt_01HRQF9VVP38R2F2DC1HQQ7MZP",
  "occurredAt": "2026-02-23T21:45:55.402Z",
  "source": {"component": "gateway-bridge", "agentId": "crew-coder-back"},
  "correlationId": "task:task_0192ES9V6F2QA5",
  "tags": {"severity": "error"},
  "data": {
    "component": "gateway-bridge",
    "severity": "error",
    "errorCode": "RUN_CMD_REJECTED",
    "message": "@@RUN_CMD npm run build rejected by operator",
    "taskId": "task_0192ES9V6F2QA5",
    "agentId": "crew-coder-back",
    "context": {
      "command": "npm run build",
      "approvalId": "appr_0192ESDR"}
  }
}
```

---

## Dashboard Field Requirements

To keep the dashboard slim while supporting advanced analytics later, every producer MUST populate the following fields so the UI can render three primary surfaces without extra queries.

**Global (applies to every event shown anywhere):**
- `schemaVersion`, `eventType`, `eventId`, `occurredAt`
- `source.component` and `correlationId`

**Agent Status Pane (from `agent.presence` events):**
- `data.status`, `data.latencyMs`, `data.uptimeSeconds`
- `source.agentId` and `data.version`
- `data.queueDepth` and `data.lastTaskId` (required for “currently running” pill)
- `heartbeatSeq` to detect stale agents without diffing timestamps client-side

**Task Timeline (from `task.lifecycle` events):**
- `data.taskId`, `data.phase`, `data.phaseOrdinal`
- `source.agentId` and `data.taskType`
- `data.durationMs` for per-phase runtime bars
- `data.result.summary` on `completed` events and `data.error` payload on `failed`

**Error Feed (from `error` events):**
- `data.severity`, `data.errorCode`, `data.message`
- `source.component`, `source.agentId` (when present)
- `data.taskId` for deep linking back to the timeline
- `data.context` as an object so the UI can render expandable JSON

Dashboards should also persist the last `agent.presence` per agent keyed by `source.agentId` so they can show stale timers even if the RT stream hiccups, and they must cache the last `task.lifecycle` event per `taskId` for resuming UI state on reload.

---

## Implementation Notes

- When emitting to `events.jsonl`, use newline-delimited JSON with no trailing commas to keep `tail -f` and `jq` tooling simple.
- `eventId` should be ULID to maintain chronological ordering while remaining sortable without an index.
- All timestamps must be UTC.
- If the RT bus or dashboard can’t parse an event, it should log the `eventId` and raw payload to `events-invalid.jsonl` for later analysis.
- Additional event types (e.g., `provider.usage`, `cmd.approval`) should inherit these envelope rules to keep ingestion and storage uniform.
