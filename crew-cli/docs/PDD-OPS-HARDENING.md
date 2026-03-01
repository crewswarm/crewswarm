# PDD — Operational Hardening Backlog (Post-Parity)

Date: 2026-03-01  
Status: Completed (2026-03-01)  
Owner: CrewSwarm CLI

---

## 1. Problem Statement

After Copilot-parity features were completed, four practical hardening items remain to improve reliability, auditability, and policy control:

1. `crew github doctor` preflight for GitHub CLI health.
2. `crew github --dry-run` preview mode for safe execution.
3. REPL replay/audit events for mode changes and autopilot actions.
4. Centralized model policy file (`.crew/model-policy.json`) for tier defaults and fallbacks.

These close operational gaps without changing core architecture.

---

## 2. Goals

- Prevent avoidable GitHub action failures before execution.
- Add safe-preview mode for all GitHub NL flows.
- Make REPL behavior auditable for debugging and team reviews.
- Centralize model-routing policy to avoid drift across commands.

---

## 3. Scope

### In Scope

- New command: `crew github doctor`
- New option: `crew github --dry-run`
- Session/checkpoint audit entries for REPL mode transitions and autopilot-triggered apply behavior
- Load and validate `.crew/model-policy.json` (optional)

### Out of Scope

- Full RBAC against GitHub organizations (future)
- Remote policy distribution (future)
- UI dashboard integration for policy editing (future)

---

## 4. Functional Requirements

### 4.1 GitHub Doctor

- Verify `gh` is installed.
- Verify `gh auth status` is valid.
- Verify repository remote can be resolved.
- Return pass/fail with actionable remediation.

### 4.2 GitHub Dry Run

- Parse NL request into intent as normal.
- Build final `gh` command string and display it.
- Never execute mutating command in dry-run mode.
- Exit code `0` on successful parse/preview.

### 4.3 REPL Audit Logging

- On mode switch (`/mode`, Shift+Tab), append session event:
  - `type: "repl_mode_change"`
  - `from`, `to`, `source` (`slash` or `keybinding`)
- On autopilot auto-apply action, append session event:
  - `type: "repl_autopilot_apply"`
  - `paths`, `success`, `error?`

### 4.4 Model Policy File

- Path: `.crew/model-policy.json`
- Schema v1:
  - `tiers.planner.primary`, `tiers.planner.fallback[]`
  - `tiers.executor.primary`, `tiers.executor.fallback[]`
  - `tiers.worker.primary`, `tiers.worker.fallback[]`
  - optional `maxCostUsd` gates per tier
- Safe behavior:
  - Missing file => defaults unchanged
  - Invalid file => warning + defaults unchanged

---

## 5. Non-Functional Requirements

- No breaking changes to existing commands.
- Best-effort behavior on optional files.
- Clear CLI error messages and deterministic exits.

---

## 6. Acceptance Criteria

- `crew github doctor` reports install/auth/repo status and fails correctly.
- `crew github --dry-run` prints parsed intent + command and performs no mutation.
- REPL mode transitions are visible in session logs.
- `.crew/model-policy.json` can centrally configure tier defaults/fallbacks.

---

## 7. Rollout Plan

1. Implement doctor + dry-run first (highest user safety impact).
2. Add REPL audit entries.
3. Add model policy loading/validation and wire to command defaults.
4. Add tests and docs updates for all above.
