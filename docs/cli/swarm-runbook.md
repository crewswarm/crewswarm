# Plugin Quality Swarm Runbook

## Objective (48h)
Raise plugin quality to release-readiness in 48 hours by fixing top-risk defects, validating core flows, and confirming telemetry coverage.

### 48h success metrics
- P0 open defects: `0`; P1 open defects: `<=2` (with owner + ETA)
- Core plugin journey pass rate: `>=95%` in regression suite
- Crash/error rate in swarm test environment: `<1%` of plugin sessions
- Telemetry completeness for required events: `>=98%`

## Workstream owners
- PM: scope, prioritization, stakeholder updates, go/no-go recommendation
- Eng (Lead): triage ownership, dependency clearing, technical decisions
- FE: UI/plugin client fixes, instrumentation, usability regressions
- BE: API/data contract fixes, reliability, performance bottlenecks
- QA: test matrix execution, bug verification, release sign-off checklist
- Data: telemetry validation, dashboard checks, anomaly review

## Prioritized deliverables
1. Triage board with ranked P0/P1 defects and assigned DRI per item
2. Hotfix bundle for top plugin blockers (core install, load, execute flows)
3. Regression evidence for critical paths (automated + manual spot checks)
4. Telemetry validation report for required plugin lifecycle events
5. Go/no-go packet: risk list, rollback readiness, and release recommendation

## Daily cadence + escalation
- `09:00` standup (15 min): blockers, priorities, owner confirmations
- `13:00` checkpoint (15 min): burn-down vs 48h targets, re-rank work
- `17:00` wrap (20 min): status snapshot, risks, next-day plan
- Escalate immediately to Eng Lead + PM if any P0 is unresolved for `>4h`, critical path pass rate drops `<90%`, or rollback trigger fires.

## Telemetry events (quick verify)
Required events:
- `plugin_install_started`
- `plugin_install_succeeded`
- `plugin_install_failed`
- `plugin_loaded`
- `plugin_execution_started`
- `plugin_execution_succeeded`
- `plugin_execution_failed`

Quick verification:
- Trigger one full plugin lifecycle in staging.
- Confirm event sequence appears in logs/dashboard within `5 min`.
- Validate required fields on each event: `timestamp`, `plugin_id`, `plugin_version`, `session_id`, `result`, `error_code` (if failed).
- Pass criteria: all required events present, ordered, and field-complete.

## Rollback plan
- Trigger rollback if: new P0 appears post-fix, error rate `>=2%` for 15 min, or critical path pass rate `<90%`.
- Actions:
  - Disable plugin rollout via feature flag / release gate.
  - Revert last plugin-quality patch set.
  - Re-deploy last known good build.
  - Announce incident + ETA in swarm channel within `10 min`.
- Exit rollback only after QA re-verifies core flows and Data confirms telemetry recovery.
