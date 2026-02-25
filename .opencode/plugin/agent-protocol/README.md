# Agent Protocol Directory

This directory is the local, non-chat protocol bus for swarm agents.

## Why this exists

- Prevent accidental use of external transports (for example, WhatsApp) for internal QA traffic.
- Keep agent-to-agent coordination local and auditable.
- Provide persistence when chat sessions drop.

## Transport model

- Default transport: append-only JSONL files in `agent-protocol/channels/`.
- Shared memory remains state storage (facts, checkpoints, handoff).
- No WSS is required for single-host local orchestration.
- Add WSS only if you need remote workers on other machines.

## Channels

- `channels/control.jsonl`: start/stop/sync commands.
- `channels/tasks.jsonl`: task envelopes and assignments.
- `channels/events.jsonl`: lifecycle events and progress updates.
- `channels/errors.jsonl`: structured failures and retries.

## Envelope

Every line must be one JSON object following `schema.json`.

Minimal required fields:

- `id`: unique message id
- `ts`: ISO timestamp
- `channel`: control | tasks | events | errors
- `from`: sender id
- `to`: receiver id or `broadcast`
- `type`: protocol message type
- `payload`: object

## Safety rules

- Do not call `openclaw_message` for internal QA/agent chatter.
- Gate external messaging behind explicit opt-in env flags.
- Keep all internal coordination in this directory + shared memory.
