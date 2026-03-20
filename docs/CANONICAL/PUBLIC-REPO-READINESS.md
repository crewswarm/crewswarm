# crewswarm Public Repo Readiness

Updated: March 14, 2026

## Current State

crewswarm is functionally strong enough for a public release.

What is working:
- dashboard, RT bus, `crew-lead`, sub-agents, MCP, Vibe, and `crewchat`
- project-aware chat/history through the dashboard
- direct CLI passthrough with safer dashboard error handling
- service restart flow for the dashboard with real health checks

What is not yet fully polished:
- UI consistency across Dashboard, Vibe, and `crewchat`
- model-picker semantics across every CLI surface
- reproducible build discipline for all served frontend assets
- naming drift in docs and helper scripts (`Studio` vs `Vibe`, `CrewChat` vs `crewchat`)

## Release Gate

Before calling the repo public-ready, these should be true:

- [x] Core services start and stop without crashing the stack
- [x] `crewchat` recovers when the dashboard comes back
- [x] Vibe direct chat and project history use the right backend paths
- [x] Dashboard restart uses health checks instead of port-only checks
- [x] One smoke command verifies dashboard, `crew-lead`, Vibe, and `crewchat`
- [x] Frontend/build outputs are regenerated from source before release
- [x] Product naming is consistent enough in the main UI, scripts, and docs
- [x] Public docs clearly separate stable features from experimental ones

## Recommended Final Pass

1. Run a release smoke:
   - `npm run smoke:static` — static checks (syntax, build, unit tests)
   - `npm run restart-all` — start stack
   - `npm run smoke` — live dispatch (crew-coder + crew-main)
   - `node scripts/health-check.mjs` — full health

2. Regenerate served assets:
   - dashboard frontend build
   - Vibe build
   - confirm served files match source

3. Normalize naming:
   - `Vibe` for the IDE surface
   - `crewchat` for the native macOS app
   - remove stale references to old modes/toggles

4. Publish with an honest support statement:
   - stable: dashboard, RT bus, `crew-lead`, agent routing, project history
   - beta: Vibe polish, native `crewchat` UX, some CLI-specific model controls

## Practical Go/No-Go

Go for a public release now.

Be honest about polish:
- stable: dashboard, RT bus, `crew-lead`, agent routing, install flow, project history, MCP
- improving: Vibe UX polish, `crewchat` UX polish, some CLI-specific controls
