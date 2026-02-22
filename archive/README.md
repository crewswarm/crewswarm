# Archived Orchestrators

**Canonical:** `unified-orchestrator.mjs` (or `node scripts/run.mjs "requirement"`).

These files are deprecated and kept for reference only.

| File | Notes |
|------|-------|
| dispatch-orchestrator.mjs | JSON-first dispatch; unified uses natural-language PM + parser |
| autonomous-orchestrator.mjs | Earlier design; PM-driven |
| ai-orchestrator.mjs | Variant |
| swarm-orchestrator.mjs | Direct RT channel I/O; unified uses gateway-bridge --send |
| orchestrator.mjs | Variant |

**Alternatives (not archived):** `natural-pm-orchestrator.mjs` — simpler PM + regex parse; good for quick tasks.
