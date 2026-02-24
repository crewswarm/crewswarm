# CrewSwarm — Ops / Core Roadmap

> Ops and core product work (telemetry, dashboard, validation). Website feature work lives in `website/ROADMAP.md`.

---

## Ops / Telemetry

- [ ] Add field matrix to docs/OPS-TELEMETRY-SCHEMA.md (all fields, type, which event type)
- [ ] Document heartbeat thresholds (e.g. offline after 90s without agent.presence) and task failure windows in schema doc
- [ ] Add event lifecycle guidance (versioning, unknown fields, retry/backoff when RT bridge can't publish)
- [ ] Define sample telemetry bundle (multiple event types in chronological order) for QA/UI replay
- [ ] Add validation guidelines (JSON Schema or tooling) and scripts/check-dashboard.mjs update for payload validation

---

## Backlog

(Add items here or under new sections.)
