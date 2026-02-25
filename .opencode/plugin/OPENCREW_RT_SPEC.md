# OpenCrewHQ Realtime Protocol (OpenCrew RT)

Version: `opencrew-rt/1`

This spec defines the realtime agent communication protocol used by orchestrator, PM, QA, and fixer/remediator agents.

## Goals

- Realtime coordination between agents over `ws`/`wss`
- Durable shared-memory log of all protocol envelopes
- Explicit assignment, issue escalation, handoff, done, and reassignment flow
- No external messaging dependency for agent-to-agent traffic

## Transport

- Server endpoint: `ws://<host>:<port>` or `wss://<host>:<port>`
- Runtime defaults:
  - host: `127.0.0.1`
  - port: `18889`
  - token auth: enabled by default
  - autostart on plugin load: enabled by default
- Durable log location:
  - `${SHARED_MEMORY_DIR}/${SHARED_MEMORY_NAMESPACE}/opencrew-rt/channels/*.jsonl`
  - `${SHARED_MEMORY_DIR}/${SHARED_MEMORY_NAMESPACE}/opencrew-rt/events.jsonl`
  - `${SHARED_MEMORY_DIR}/${SHARED_MEMORY_NAMESPACE}/opencrew-rt/acks.jsonl`

## Auth and Access Control

- Tool-level auth uses existing bridge controls:
  - `OPENCLAW_REQUIRE_API_KEY`
  - `OPENCLAW_API_KEY`
  - `OPENCLAW_ALLOWED_AGENTS`
- Socket-level auth uses hello token (default on):
  - `OPENCREW_RT_REQUIRE_TOKEN=1`
  - `OPENCREW_RT_AUTH_TOKEN=<secret>`
- Optional per-agent tokens (recommended for internet exposure):
  - `OPENCREW_RT_REQUIRE_AGENT_TOKEN=1`
  - `OPENCREW_RT_AGENT_TOKENS="openclaw-main:tokenA;opencode-pm:tokenB;opencode-qa:tokenC"`
- Optional origin restrictions:
  - `OPENCREW_RT_ALLOWED_ORIGINS="https://ops.example.com,https://crew.example.com"`

## Envelope Schema

Each published message is stored and transmitted as:

```json
{
  "id": "uuid",
  "ts": "2026-02-19T12:34:56.000Z",
  "channel": "assign",
  "from": "orchestrator",
  "to": "qa-engineer-gpt5",
  "type": "task.assigned",
  "taskId": "task-123",
  "correlationId": "corr-456",
  "priority": "high",
  "payload": {}
}
```

Required fields: `id`, `ts`, `channel`, `from`, `to`, `type`, `payload`.

## Channels

Standard channels:

- `command`: explicit control-plane commands
- `assign`: PM/orchestrator assignment flow
- `status`: progress updates and heartbeats
- `issues`: QA failures and blocker escalation
- `handoff`: ownership transfer between agents
- `done`: completion notifications and artifacts
- `reassign`: task rerouting directives
- `events`: general protocol events

## Socket Message Types

Client -> Server:

- `hello`: authenticate client and declare agent id
- `ping`: keepalive
- `subscribe`: subscribe to channels (`*` allowed)
- `publish`: publish a protocol envelope
- `ack`: persist ack status for a message id

Server -> Client:

- `server.hello`
- `hello.ack`
- `pong`
- `subscribe.ack`
- `publish.ack`
- `ack.logged`
- `message` (delivered envelope)
- `error`

## Delivery Semantics

- At-least-once delivery to connected subscribers/targets
- Envelopes are always appended to shared-memory channel logs
- Use `correlationId` + `id` for idempotent consumer handling
- Acks are durable in `acks.jsonl`
- Server-side message size guard and per-connection rate limiting are enforced.

## Agent Workflow

1. Orchestrator publishes `command.run_task` on `command` (or `task.assigned` on `assign`)
2. Worker agent acks `received`, then posts `status` updates
3. QA publishes `qa.issue` on `issues` to fixer if validation fails
4. Fixer posts `status` and final `task.done` on `done`
5. PM/orchestrator can publish `task.reassigned` on `reassign`

## Plugin Tools

Implemented in `opencrew-rt.ts`:

- `opencrew_rt_server`: start/stop/status ws/wss server
- `opencrew_rt_publish`: generic envelope publish
- `opencrew_rt_assign`: assignment helper (`task.assigned`)
- `opencrew_rt_issue`: QA issue helper (`qa.issue`)
- `opencrew_rt_command`: command helper (`command.*`)
- `opencrew_rt_pull`: read persisted channel messages
- `opencrew_rt_ack`: durable ack write

## Command Actions

Allowed `command` message types:

- `command.spawn_agent`
- `command.run_task`
- `command.cancel_task`
- `command.reassign_task`
- `command.collect_status`

Invalid `command` types are rejected server-side.

## Recommended Agent IDs

- `orchestrator`
- `opencode-pm`
- `opencode-qa`
- `opencode-fixer`
- `openclaw-main`

Use unique identities per role to avoid routing ambiguity.

## Environment Variables

- `OPENCREW_RT_HOST` (default `127.0.0.1`)
- `OPENCREW_RT_PORT` (default `18889`)
- `OPENCREW_RT_REQUIRE_TOKEN` (default `1`)
- `OPENCREW_RT_AUTH_TOKEN` (required when token auth enabled)
- `OPENCREW_RT_TLS_KEY_PATH` (optional for WSS)
- `OPENCREW_RT_TLS_CERT_PATH` (optional for WSS)
- `OPENCREW_RT_AUTO_START` (default `1`)
- `OPENCREW_RT_BOOTSTRAP_CHANNELS` (default `1`)
- `OPENCREW_RT_REQUIRE_AGENT_TOKEN` (default `0`)
- `OPENCREW_RT_AGENT_TOKENS` (optional `agent:token;agent:token` map)
- `OPENCREW_RT_ALLOWED_ORIGINS` (optional comma-separated allowlist)
- `OPENCREW_RT_MAX_MESSAGE_BYTES` (default `65536`)
- `OPENCREW_RT_RATE_LIMIT_PER_MIN` (default `300`)

## Boot Integration

- OpenCode should load `opencrew-suite.ts` as plugin entrypoint.
- On plugin load, OpenCrew RT bootstraps standard channel files and attempts server autostart.
- Boot state is written to:
  - `${SHARED_MEMORY_DIR}/${SHARED_MEMORY_NAMESPACE}/opencrew-rt/boot-status.json`

## OpenClaw Realtime Bridge

`~/Desktop/OpenClaw/gateway-bridge.mjs` supports OpenCrew RT client modes:

- `--rt-status`: verify realtime connectivity/auth
- `--rt-daemon`: subscribe and execute realtime tasks through OpenClaw chat

Relevant environment:

- `OPENCREW_RT_URL` (example `wss://127.0.0.1:18889`)
- `OPENCREW_RT_AUTH_TOKEN`
- `OPENCREW_RT_AGENT` (recommended `openclaw-main`)
- `OPENCREW_RT_CHANNELS` (default `command,assign,handoff,reassign,events`)
- `OPENCREW_RT_TLS_INSECURE=1` (optional for self-signed local WSS)

## Safety Rules

- Internal agent coordination must use OpenCrew RT + shared memory logs.
- External messaging (`openclaw_message`) is for approved human contacts only.
- Keep `OPENCLAW_ALLOW_UNRESTRICTED_MESSAGING=0` in normal operation.
