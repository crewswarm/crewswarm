# L1/L2/L3 Routing, Persona Loading, and CLI->TUI Plan

Date: 2026-03-01
Status: Design write-up for implementation

## 1) Target Runtime Model (Standalone + Connected)

Single mental model:
1. L1 chat is UX only.
2. L2 does decisioning/planning/policy.
3. L3 executes work units.

Two deployment modes:
1. connected: L3 can dispatch to full CrewSwarm gateway agent roster.
2. standalone: L3 executes locally (no gateway required), with optional specialist emulation via prompt personas.

## 2) Escalation Policy: When L1 hands off to L2

L1 should not decide complexity by vibe. Use deterministic pre-check + model confirmation.

Hard escalation triggers (any true => escalate to L2 planning):
1. user explicitly asks for a specialist (PM/QA/security/frontend/UI/UX/ML/research/etc).
2. task asks for roadmap/plan/multi-step/multi-file refactor.
3. task asks for both implementation and validation ("build + test + review").
4. estimated touched files > 3 or estimated subsystems > 1.
5. risk-sensitive keywords: auth, secrets, payments, prod, migration, infra, security.

Direct-answer path:
1. greetings/status/help/model config questions.
2. single factual answer with no code changes requested.

Single-exec path:
1. one bounded coding change with no specialist requirements.

## 3) L2 Architecture: One vs Two L2 Models

Recommended: dual-L2 remains enabled for complex tasks.

Role split:
1. L2A Decomposer: produce work graph (units, dependencies, persona requirements, estimated cost).
2. L2B Policy Validator: validate risk/cost/capabilities, approve/reject/revise.

Interaction mode:
1. keep sequential handoff by default (L2A -> L2B), deterministic and cheaper.
2. allow one revision turn when L2B rejects (L2B feedback -> L2A patch graph -> revalidate).
3. max revision rounds: 1 (hard cap), then fail closed.

This gives stronger quality without unbounded L2 chatter.

## 4) Persona Registry Coverage (20-role aligned)

Use a normalized persona registry at L2/L3 boundary. Map user intent to required persona set.

Core engineering:
1. crew-coder: full-stack implementation.
2. crew-coder-front: frontend implementation.
3. crew-coder-back: backend/API/data.
4. crew-fixer: bug triage and repair loops.
5. crew-qa: tests, validation, regression checks.
6. crew-security: threat/risk/security checks.
7. crew-architect: architecture/infra/system design.
8. crew-github: git/PR/release operations.

Product and coordination:
1. crew-pm: roadmap/PDD/acceptance criteria.
2. crew-main: synthesis/coordinator for multi-agent outputs.
3. crew-orchestrator/orchestrator: pipeline coordination role.

Experience and content:
1. crew-frontend: UI/UX design quality and polish.
2. crew-copywriter: docs, user-facing content.
3. crew-seo: discoverability/content SEO.
4. crew-researcher: web/market/technical research.

AI/automation and channels:
1. crew-ml: ML/LLM pipeline specialist.
2. crew-mega: heavy general purpose fallback.
3. crew-telegram: Telegram channel ops.
4. crew-whatsapp: WhatsApp channel ops.

Execution policy by mode:
1. connected: route to real gateway agents.
2. standalone: map to local prompt personas with same capability contract.

## 5) Does it "build till done"?

Recommended answer: bounded waves, not infinite autonomy.

Execution loop:
1. L2 emits work graph with explicit done criteria per unit.
2. L3 executes dependency-ordered waves in parallel batches.
3. After each wave, L2 checks completion + risk + cost budget.
4. Stop when all acceptance criteria pass or any hard gate fails.

Hard caps:
1. max waves per request: 5.
2. max work units per graph: 30.
3. max revisions from validator: 1.
4. max cost budget: policy-driven (existing gate already present).
5. max wall-clock: profile-based timeout.

## 6) Standalone Expert Behavior (self-help)

Default self-help behavior should always answer from local truth first:
1. active mode (connected vs standalone).
2. configured L1/L2/L3 model stack.
3. available commands and endpoints.
4. repo-local docs/index summary.

Policy:
1. system questions must prefer local index/config introspection over generic LLM claims.
2. if data unavailable, answer explicitly with missing source path and next command.

## 7) CLI -> TUI Migration Difficulty

Short answer: medium difficulty, low architecture risk, mostly presentation + event loop work.

Effort estimate (engineering days):
1. TUI shell + panes + keybindings (logs/chat/status/input): 2-3 days.
2. Streaming response renderer + diff preview widget: 2-3 days.
3. task graph panel (L2 plan + L3 wave progress): 1-2 days.
4. command palette/help + mode switch UX cleanup: 1-2 days.
5. integration hardening + tests (snapshot + interaction): 2-3 days.

Total: 8-13 days for production-grade TUI.

Suggested stack:
1. ink/react for maintainability and componentized UI.
2. fallback to plain REPL when no TTY/CI.
3. keep command engine shared; TUI is adapter, not rewrite.

## 8) Migration Plan (No Rewrite)

Phase 1:
1. extract REPL state/events into reusable controller.
2. keep command handlers unchanged.

Phase 2:
1. add `crew tui` entrypoint backed by same controller.
2. implement panes: Chat, Tasks, Files, Cost, Trace.

Phase 3:
1. add interactive diff approval/apply from TUI.
2. add L2 plan graph and L3 wave progress timeline.

Phase 4:
1. usability pass: mode naming, hints, onboarding defaults.
2. parity test matrix: REPL and TUI produce same execution outcomes.

## 9) Recommended Immediate Changes

1. Make unified routing path mandatory in standalone (`CREW_USE_UNIFIED_ROUTER=true` default in standalone mode).
2. Enforce deterministic escalation triggers before any model call.
3. Add one-round L2A<->L2B revision loop for rejected plans.
4. Introduce explicit `maxWaves`, `maxUnits`, and per-wave acceptance checks.
5. Add `crew explain-stack` to print exact active roles, models, and fallback chain.

## 10) Acceptance Criteria for this architecture update

1. A system question about models always returns real configured values from local files/env.
2. "Need a PM" routes to PM persona deterministically.
3. "Build X with tests" creates multi-wave graph and executes bounded plan.
4. standalone mode completes without gateway.
5. connected mode can use full external agent roster.
6. TUI and CLI produce equivalent task outcomes for same run config.
