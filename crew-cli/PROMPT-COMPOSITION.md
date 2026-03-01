# Dynamic Prompt Composition & Dual-L2 Planning

## Overview

The CLI now supports **dynamic prompt composition** with strict guardrails and **dual-tier Level-2 planning** for complex tasks.

## Architecture

### 3-Tier System with Optional Dual-L2

```
User Input
    ↓
Tier 1: Router (decides CHAT/CODE/DISPATCH)
    ↓
[IF COMPLEX] → Dual-L2 Planning:
    ├─ L2A: Decomposer (breaks into work graph + personas)
    └─ L2B: Policy Validator (risk/cost/compliance check)
    ↓
Tier 2: Local Executor (executes with composed prompts)
    ↓
[IF NEEDED] → Tier 3: Gateway Specialists
```

## Prompt Registry System

### Immutable Base Prompts

All prompts start from versioned, immutable templates:

- `router-v1` - Task routing
- `executor-code-v1` - Code generation
- `executor-chat-v1` - Conversational
- `decomposer-v1` - Task decomposition (L2A)
- `policy-validator-v1` - Risk validation (L2B)
- `specialist-qa-v1` - QA specialist (Tier 3)
- `specialist-pm-v1` - Project manager (Tier 3)

### Controlled Overlays

Each template only allows specific overlay types:

**Overlay Types**:
- `task` - The user's request
- `context` - Repo/project context
- `safety` - Security constraints
- `constraints` - Cost/resource limits

**Example**:
```typescript
const overlays: PromptOverlay[] = [
  { type: 'task', content: 'Build a REST API', priority: 1 },
  { type: 'context', content: 'Using Express.js', priority: 2 },
  { type: 'safety', content: 'No database writes', priority: 3 }
];

const composed = composer.compose('executor-code-v1', overlays, traceId);
```

### Capability Matrix

Each persona has defined capabilities:

```typescript
'executor-code': [
  'code-generation',
  'refactoring',
  'documentation',
  'debugging',
  'file-write'
]

'specialist-qa': [
  'testing',
  'auditing',
  'validation',
  'security-review',
  'file-read'
]
```

## Dual-L2 Planning (Optional)

Enable with `CREW_DUAL_L2_ENABLED=true` for complex tasks.

### L2A: Decomposer

Breaks tasks into structured work graphs:

```json
{
  "units": [
    {
      "id": "auth-api",
      "description": "Build authentication endpoints",
      "requiredPersona": "executor-code",
      "dependencies": [],
      "estimatedComplexity": "medium",
      "requiredCapabilities": ["code-generation", "file-write"]
    },
    {
      "id": "test-auth",
      "description": "Test auth endpoints",
      "requiredPersona": "specialist-qa",
      "dependencies": ["auth-api"],
      "estimatedComplexity": "low",
      "requiredCapabilities": ["testing", "validation"]
    }
  ],
  "totalComplexity": 6,
  "requiredPersonas": ["executor-code", "specialist-qa"],
  "estimatedCost": 0.015
}
```

### L2B: Policy Validator

Validates work graphs for safety:

```json
{
  "approved": true,
  "riskLevel": "medium",
  "concerns": [
    "Requires file system writes",
    "Estimated cost: $0.015"
  ],
  "recommendations": [
    "Use sandbox for file writes",
    "Review generated code before apply"
  ],
  "fallbackStrategy": "Use local executor only if QA specialist unavailable",
  "estimatedCost": 0.015
}
```

## Guardrails

### 1. Prompt Immutability

✅ **Allowed**:
- Adding overlays from allowed list
- Composing base + overlays
- Versioning templates

❌ **Blocked**:
- Freeform prompt replacement
- Modifying base prompts at runtime
- Unregistered overlay types

### 2. Capability Enforcement

Before executing, check:
```typescript
if (!hasCapability(persona, 'file-write')) {
  throw new Error('Persona lacks file-write capability');
}
```

### 3. Cost Gates

```typescript
if (workGraph.estimatedCost > 0.50) {
  // Require approval or simplify
}
```

### 4. Risk Assessment

```typescript
if (validation.riskLevel === 'critical') {
  // Block or require explicit approval
}
```

## Execution Trace

Every task gets a deterministic trace:

```bash
crew(manual)> /trace

╔══════════════════════════════════════════════════════════════╗
║                    EXECUTION TRACE                           ║
╚══════════════════════════════════════════════════════════════╝

Trace ID: repl-abc123-def456

Execution Path:
  1. router → DISPATCH decision
  2. dual-l2-planner → enabled
  3. l2a-decomposer → generated 3 work units
  4. l2b-policy-validator → approved (risk: medium)
  5. executor-code → completed auth-api
  6. specialist-qa → completed test-auth

Composed Prompts:
  ├─ decomposer-v1 (1.0.0)
  │  └─ overlays: task, context, constraints
  ├─ policy-validator-v1 (1.0.0)
  │  └─ overlays: safety, constraints
  └─ executor-code-v1 (1.0.0)
     └─ overlays: task, context, safety

Total Cost: $0.0145
```

## Usage

### Enable Dual-L2 Planning

```bash
# In .zshrc or environment
export CREW_DUAL_L2_ENABLED=true

# Or in REPL
crew(manual)> /config dual-l2 on
```

### Configure Stack with Dual-L2

```bash
crew(manual)> /stack

? Tier 1: Router: Grok (x.ai)
? Tier 2: Executor: Grok (x.ai)
? Enable Dual-L2 Planning? Yes
? Tier 3: Gateway: Disabled

✓ Stack configured:
  Tier 1 (Router)    : grok
  Tier 2A (Decomposer): grok (optional)
  Tier 2B (Validator) : grok (optional)
  Tier 2 (Executor)  : grok
  Tier 3 (Gateway)   : disabled
```

### Check Composed Prompts

```bash
crew(manual)> /trace

# Shows full execution path and all composed prompts
```

## Benefits

1. **Prompt Alignment** - No more fragmentation between router/executor/crew-main
2. **Explicit Control** - Know exactly what each persona can do
3. **Safety** - Validated overlays, capability checks, risk gates
4. **Auditability** - Full trace of decisions and composed prompts
5. **Cost Control** - Estimate before execution, approve expensive operations
6. **Flexibility** - Dual-L2 optional, use only when needed

## When to Use Dual-L2

**Enable for**:
- Complex multi-step tasks
- Tasks requiring multiple specialists
- High-risk operations (file system, network)
- Expensive operations ($0.10+)

**Skip for**:
- Simple questions
- Single-file code generation
- Read-only operations
- Low complexity tasks

## Configuration Files

### Prompt Templates

Located in: `src/prompts/registry.ts`

### Capability Matrix

Located in: `src/prompts/registry.ts` (CAPABILITY_MATRIX)

## Standalone Persona Coverage (20 roles)

The standalone prompt registry now maps the full CrewSwarm role set to explicit templates/capabilities so local mode can answer and execute with role-aware behavior.

Covered persona ids:

1. `crew-coder`
2. `crew-coder-front`
3. `crew-coder-back`
4. `crew-frontend`
5. `crew-qa`
6. `crew-fixer`
7. `crew-security`
8. `crew-pm`
9. `crew-main`
10. `crew-orchestrator`
11. `orchestrator`
12. `crew-architect`
13. `crew-researcher`
14. `crew-copywriter`
15. `crew-seo`
16. `crew-ml`
17. `crew-github`
18. `crew-mega`
19. `crew-telegram`
20. `crew-whatsapp`

Runtime note:

1. `UnifiedPipeline` now resolves templates by persona id (`getTemplateForPersona`) instead of a PM/QA-only hardcoded branch.
2. `DualL2Planner` allows these persona ids in decomposition output constraints.

### Risk Levels

- `low` - Questions, read-only ops
- `medium` - Code generation, file writes
- `high` - Multi-agent coordination, external APIs
- `critical` - System operations, destructive actions

## Future Enhancements

- [ ] User-defined custom personas (with approval workflow)
- [ ] Prompt A/B testing and version comparison
- [ ] Cost optimization suggestions
- [ ] Auto-fallback to simpler plans if cost exceeds threshold
- [ ] Prompt template marketplace
