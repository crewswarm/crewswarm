# Routing

Shared chat, mentions, dispatch, and thread continuity.

## Shared chat participants

In shared chat surfaces (Dashboard Swarm Chat, shared `projectId` rooms, MCP clients), autonomous `@mentions` route to:

- **Agents:** `@crew-coder`, `@crew-qa`, `@crew-pm`, any canonical `crew-*` agent ID
- **CLI participants:** `@codex`, `@cursor`, `@claude`, `@opencode`, `@gemini`, `@crew-cli`

Participants can hand off by mentioning another in-channel. Direct engine passthrough remains available separately.

## Dispatch

From chat or API:

```
dispatch crew-coder to write a login endpoint with JWT
have crew-qa audit the last PR
```

Or pipeline:

```
@@PIPELINE [
  {"wave":1, "agent":"crew-coder", "task":"Write /src/auth.ts — JWT login"},
  {"wave":2, "agent":"crew-qa",    "task":"Test the auth endpoint"}
]
```

Tasks in the same `wave` run in parallel. Higher waves wait for lower waves.

## Thread continuity

- Per-project chat history in `~/.crewswarm/project-messages/{projectId}/messages.jsonl`
- Session binding persists across tab switches
- RAG search over project messages: `GET /api/crew-lead/search-messages-semantic?projectId=...&q=...`

## Coordinator IDs

Bare aliases (`coder`, `pm`) are normalized to canonical RT IDs. Coordinators that can emit `@@DISPATCH` are in `lib/agent-registry.mjs` → `COORDINATOR_AGENT_IDS` and enforced in `gateway-bridge.mjs`:

- `crew-main`, `crew-pm`, `crew-pm-cli`, `crew-pm-frontend`, `crew-pm-core`, `crew-orchestrator`
