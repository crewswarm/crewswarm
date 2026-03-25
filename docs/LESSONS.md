# Crew Lessons

Recurring failure modes worth keeping in repo memory.

## Project Context

- Keep dashboard and Vibe on the same shared project registry and active-project state.
- Do not fall back from a surface-selected project to a global engine project silently.
- Treat `general` as chat scope, not as a filesystem project.

## Runtime Reliability

- Do not rely on bare `node` in service launchers. Resolve the intended runtime explicitly.
- Prefer Node 20 for long-running CrewSwarm services on this machine class; Node 24 caused loader instability.
- Health checks should prefer real runtime signals such as RT `/status`, not only inferred local state.

## Engine Routing

- Do not leak the main chat model into CLI runtimes. CLI model selection needs its own per-engine path.
- Distinguish persistent services from per-task CLIs in both status and UX.
- OpenCode server availability should not be treated as equivalent to all CLI engines being healthy.

## Dispatch And Coordination

- Direct dispatch commands should bypass the LLM path whenever possible.
- If a response claims dispatch but no dispatch occurred, treat that as a bug, not acceptable behavior.
- Shared chat reply delivery needs a fallback path when live SSE drops.

## Tests

- Browser-backed smoke tests are necessary for surfaces that depend on streaming, dispatch, and project selection.
- Keep tests aligned with the current UI and runtime shape; stale assertions create noise and hide real regressions.
- Quality harnesses should verify behavior, not obsolete implementation details.
