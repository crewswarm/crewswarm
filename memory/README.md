# Memory

This directory contains the small public subset of CrewSwarm memory that is useful as durable repo context.

Tracked files here should be:

- stable across sessions
- safe to publish
- architectural or behavioral guidance rather than live state

The public subset is:

- `law.md` — high-level operating principles for agents
- `lessons.md` — recurring failure modes and practical corrections
- `orchestration-protocol.md` — dispatch and coordination rules

Local/session-derived memory is intentionally not tracked in git. That includes files such as:

- `brain.md`
- `session-log.md`
- `current-state.md`
- `agent-handoff.md`
- `telegram-context.md`
- `whatsapp-context.md`

Those files may be useful locally, but they often contain transient runtime state, local paths, or session residue that should not ship in the public repo.
