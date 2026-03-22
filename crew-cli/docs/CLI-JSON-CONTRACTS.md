# CLI JSON Contracts (v1)

This document defines stable JSON envelopes for key runtime commands.

All envelopes follow:

```json
{
  "version": "v1",
  "kind": "<event-kind>",
  "ts": "ISO-8601 timestamp",
  "...": "payload"
}
```

## `crew chat --json`

`kind`: `chat.result`

Fields:
- `route`: router decision payload
- `agent`: selected agent id
- `response`: final text response
- `edits`: sandbox-staged file paths
- `needsApproval`: boolean (`true` when edits exist)
- `traceId`: pipeline trace id when available
- `timeline`: pipeline phase timeline (standalone/unified path)
- `capabilityHandshake`: runtime capability map

## `crew dispatch ... --json`

`kind`: `dispatch.result`

Fields:
- `runId`: dispatch checkpoint run id
- `agent`: target agent
- `taskId`: gateway task id when available
- `success`: boolean
- `response`: final text response
- `edits`: sandbox-staged file paths
- `needsApproval`: boolean
- `risk`: patch risk object when edits exist
- `blastRadius`: blast-radius report when edits exist
- `capabilityHandshake`: runtime capability map

## `crew run --json`

`kind`: `run.result`

Fields:
- `task`: executed task text
- `resumedFrom`: trace id when run is resumed/replayed
- `previousPhase`: last phase from prior trace when resuming
- `resumedPhase`: requested resume phase (`plan|execute|validate`) when provided
- `traceId`: current pipeline trace id
- `phase`: terminal phase (`complete` expected on success)
- `timeline`: full phase timeline
- `response`: final text response
- `edits`: sandbox-staged file paths
- `needsApproval`: boolean
- `capabilityHandshake`: runtime capability map

`kind`: `run.resume` (no-op resume case)
- emitted when the referenced trace is already complete and execution is skipped.

Phase-aware resume:
- `crew run --resume <traceId> --from-phase execute` reuses prior plan artifact when available.
- `crew run --resume <traceId> --from-phase validate` reuses prior plan + prior validate input when available.

## `crew capabilities --json`

`kind`: `capabilities`

Fields:
- `handshake.mode`
- `handshake.can_read`
- `handshake.can_write`
- `handshake.can_pty`
- `handshake.can_lsp`
- `handshake.can_dispatch`
- `handshake.can_git`

## Notes

- These envelopes are additive-compatible: new fields may be added, existing fields remain stable.
- For CI, consume `version` + `kind` first, then parse payload fields.
