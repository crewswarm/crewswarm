# Coverage Matrix

This document tracks what is genuinely covered, what is verified by bounded or live tests, and what still depends on manual QA.

## Hermetic Coverage

- Core engine selection and fallback helpers
  - `test/unit/engine-routing.test.mjs`
  - `test/unit/engine-registry-selection.test.mjs`
  - `test/unit/engine-registry.test.mjs`
  - `test/unit/engine-settings-matrix.test.mjs`
  - `test/unit/ws-router-engine-fallback.test.mjs`
- Coordinator dispatch payload enrichment
  - `test/unit/coordinator-dispatch.test.mjs`
- Website discovery and linking
  - `test/unit/website-pages.test.mjs`
  - `test/unit/website-discovery-files.test.mjs`
- `crew-cli` runtime and REPL behavior
  - `crew-cli/tests/*`
  - `crew-cli/tests/unit/*`

## Integration / Bounded Verification

- Dashboard workflow CRUD and API contracts
  - `test/integration/workflow-crud.test.mjs`
- Direct LLM fallback behavior
  - `test/integration/llm-direct.test.mjs`
- Dashboard agent settings persistence and backup creation
  - `test/integration/agents-config-settings.test.mjs`

## UI / Browser Coverage

- Dashboard Services, Engines, and Workflows tabs
  - `tests/e2e/dashboard-tabs.spec.js`
- Dashboard Chat, Memory, and Benchmarks core surfaces
  - `tests/e2e/dashboard-core-surfaces.spec.js`
- Dashboard Agents tab engine assignment wiring
  - `tests/e2e/agents-tab.spec.js`
- Dashboard Providers and Settings save wiring
  - `tests/e2e/providers-settings.spec.js`
- Vibe editor, autosave, and chat basics
  - `tests/e2e/vibe-editor.spec.js`
- Vibe project routing and deterministic chat mode wiring
  - `tests/e2e/vibe-chat-routing.spec.js`

## Live / Environment-Dependent

- PM loop multi-engine dispatch
  - `test/e2e/pm-loop-multi-engine.test.mjs`
- Dashboard chat tabs against running services
  - `test/e2e/dashboard-chat-tabs.test.mjs`
- Telegram / WhatsApp bridges
  - `test/e2e/telegram-roundtrip.test.mjs`
  - `test/e2e/whatsapp-roundtrip.test.mjs`

## Manual QA Still Required

- Full native macOS `crewchat` interaction
- Full Dashboard/Vibe visual and responsive polish pass across every sub-view
- Provider billing and real vendor quota edge cases across every provider
- Production deploy health for external services
- Cross-surface visual polish and accessibility checks

## Interpretation

- `Hermetic Coverage` means the test can run locally or in CI without external services.
- `Integration / Bounded Verification` means the test verifies a real code path but may depend on spawned services or bounded runtime assumptions.
- `Live / Environment-Dependent` means credentials, running services, or third-party systems are required.
