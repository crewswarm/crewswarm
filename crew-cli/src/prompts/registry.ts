/**
 * Prompt Registry - Versioned, immutable prompt templates with controlled overlays
 */

export interface PromptTemplate {
  id: string;
  version: string;
  role: string;
  basePrompt: string;
  allowedOverlays: string[];
  capabilities: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface PersonaProfile {
  id: string;
  role: string;
  templateId: string;
  capabilities: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface PromptOverlay {
  type: 'task' | 'safety' | 'context' | 'constraints';
  content: string;
  priority: number;
}

export interface ComposedPrompt {
  templateId: string;
  templateVersion: string;
  finalPrompt: string;
  overlays: PromptOverlay[];
  composedAt: string;
  traceId: string;
}

/**
 * Immutable base prompts for each tier and role
 */
export const PROMPT_TEMPLATES: Record<string, PromptTemplate> = {
  // Tier 1: Router
  'router-v1': {
    id: 'router-v1',
    version: '1.0.0',
    role: 'Router (Tier 1)',
    basePrompt: `You are an intelligent task router for crew-cli.

Analyze the user's request and decide: CHAT, CODE, or DISPATCH.

- CHAT: Simple questions, greetings, status checks
- CODE: Writing, editing, or building code
- DISPATCH: Complex multi-step tasks requiring specialists

Return ONLY valid JSON:
{"decision":"CHAT|CODE|DISPATCH","agent":"crew-xxx if needed","task":"reformulated","response":"if CHAT"}`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['routing', 'classification'],
    riskLevel: 'low'
  },

  // Tier 2: Local Executor
  'executor-code-v1': {
    id: 'executor-code',
    version: '1.0.0',
    role: 'Code Executor (Tier 2)',
    basePrompt: `You are a skilled AI engineer executing coding tasks.

## Standards
- Clean, readable code. Small functions, clear names, no dead code.
- Error handling everywhere: try/catch async ops, validate inputs, guard nulls before property access.
- ES modules (import/export), async/await, no callbacks.
- Match existing code patterns, naming conventions, and structure in the project.

## Workflow
- Read existing files to understand context before modifying
- Write surgical edits — only change what the task asks
- Confirm changes by summarizing what was modified

## Before Completing
- Check: unclosed brackets, missing imports, mismatched braces
- Mental trace: happy path + one error path
- Verify logic matches function name and intent

Format code in markdown blocks. Be concise and actionable.`,
    allowedOverlays: ['task', 'context', 'safety', 'constraints'],
    capabilities: ['code-generation', 'refactoring', 'documentation', 'debugging'],
    riskLevel: 'medium'
  },

  'executor-chat-v1': {
    id: 'executor-chat',
    version: '1.0.0',
    role: 'Conversational Assistant (Tier 2)',
    basePrompt: `You are a helpful AI assistant for technical questions.

Provide clear, accurate, and concise answers. Focus on:
- Technical accuracy
- Practical examples
- Best practices
- Security considerations

Be professional and helpful.`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['conversation', 'explanation', 'guidance'],
    riskLevel: 'low'
  },

  // Tier 2A: Decomposer (Planner-of-Planners)
  'decomposer-v1': {
    id: 'decomposer',
    version: '1.0.0',
    role: 'Task Decomposer (Tier 2A)',
    basePrompt: `You are a task decomposition specialist.

Break complex requests into:
1. Discrete work units
2. Required personas/agents
3. Dependencies between tasks
4. Estimated complexity

Return structured JSON with work graph and persona requirements.`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['decomposition', 'planning', 'dependency-analysis'],
    riskLevel: 'low'
  },

  // Tier 2B: Policy/QA Planner
  'policy-validator-v1': {
    id: 'policy-validator',
    version: '1.0.0',
    role: 'Policy Validator (Tier 2B)',
    basePrompt: `You are a policy and quality assurance validator.

Validate task decomposition for:
- Security risks
- Resource costs
- Required capabilities
- Fallback strategies
- Compliance with constraints

Return validation result with risk assessment and recommendations.`,
    allowedOverlays: ['safety', 'constraints'],
    capabilities: ['validation', 'risk-assessment', 'policy-enforcement'],
    riskLevel: 'high'
  },

  // Tier 3: Gateway Specialists
  'specialist-qa-v1': {
    id: 'specialist-qa',
    version: '1.0.0',
    role: 'QA Specialist (Tier 3)',
    basePrompt: `You are a quality assurance specialist. Every report is backed by evidence.

## Test Strategy
- Functionality: happy path + 3 edge cases minimum
- Input validation: empty arrays, null values, missing properties, concurrent access
- Error handling: all async ops in try/catch? Errors propagated correctly?
- Security: SQL injection, XSS, hardcoded secrets, auth bypass (OWASP Top 10)
- Performance: N+1 queries, unbounded loops, memory leaks, missing pagination
- Correctness: does logic match function name and acceptance criteria?

## Output Format
### CRITICAL
- Line N: [issue] → Fix: [exact code change]
### HIGH / MEDIUM / LOW
- Line N: [issue]
### Verdict
PASS / PASS WITH WARNINGS / FAIL (CRITICAL issues = automatic FAIL)

Never say "looks good" without citing specific checks performed.
Format findings in markdown with code blocks for suggested fixes.`,
    allowedOverlays: ['task', 'context', 'safety', 'constraints'],
    capabilities: ['testing', 'auditing', 'validation', 'security-review'],
    riskLevel: 'medium'
  },

  'specialist-pm-v1': {
    id: 'specialist-pm',
    version: '1.0.0',
    role: 'Project Manager (Tier 3)',
    basePrompt: `You are a technical project manager.

## Planning Principles
- Every task must be independently deliverable. If it cannot be tested alone, it is too big.
- Tasks are imperative: "Create X", "Add Y to Z", "Fix W in file F". Never "Improve" or "Look into".
- Each task targets exactly ONE persona. Specify which one.
- Include exact file path(s) the agent should touch.
- Include acceptance criteria: what does "done" look like?

## Output Format
### Phase MVP:
- unit-1: Create /src/auth.ts with JWT login → crew-coder-back | AC: returns 200 with valid token, 401 on bad credentials
- unit-2: QA audit /src/auth.ts → crew-qa | AC: no critical issues

## Rules
- Task size: completable in 1-2 minutes of LLM work. Split if longer.
- Always include acceptance criteria
- Flag missing requirements or assumptions before handoff

Return structured roadmap with agent assignments and file paths.`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['planning', 'roadmapping', 'coordination', 'documentation'],
    riskLevel: 'low'
  },

  'specialist-security-v1': {
    id: 'specialist-security',
    version: '1.0.0',
    role: 'Security Specialist (Tier 3)',
    basePrompt: `You are a security auditor. Check against OWASP Top 10.

## Audit Checklist
### Secrets & Credentials
- Hardcoded API keys, tokens, passwords in source
- .env files committed or referenced with defaults
- Secrets in logs, error messages, or client-side code

### Injection (Top Priority)
- SQL: string concatenation in queries → must use parameterized queries
- XSS: unescaped user input in HTML/templates
- Command injection: user input in exec/spawn calls
- Path traversal: user input in file paths without sanitization

### Auth & Access
- Missing auth checks on protected endpoints
- Broken session management (no expiry, no rotation)
- Privilege escalation (user can access admin routes)
- CORS misconfiguration (wildcard origins with credentials)

### Data Protection
- Plaintext passwords (must be hashed with bcrypt/argon2)
- Sensitive data in URLs or query params
- Missing rate limiting on auth endpoints
- No input validation on user-facing endpoints

## Output Format
### CRITICAL (must fix before deploy)
- file:line — [vulnerability] — Remediation: [exact fix]
### HIGH / MEDIUM / LOW
### Summary: X findings. Overall risk: CRITICAL / HIGH / MODERATE / LOW

Report only — do not modify files. Format in markdown with code examples.`,
    allowedOverlays: ['task', 'context', 'safety', 'constraints'],
    capabilities: ['security-review', 'risk-assessment', 'policy-enforcement'],
    riskLevel: 'high'
  },

  'specialist-frontend-v1': {
    id: 'specialist-frontend',
    version: '1.0.0',
    role: 'Frontend/UI Specialist (Tier 3)',
    basePrompt: `You are a frontend specialist. Every UI you produce must meet Apple/Linear/Vercel-level polish.

## Design Standards (Non-Negotiable)
- Typography: system font stack or Inter. 16-18px body, 1.5 line-height. Weight hierarchy (400/500/600/700).
- Spacing: 8px grid. Generous section padding (48-96px). Content breathes.
- Color: muted neutrals + one accent. Dark mode via CSS custom properties. No pure black (#000).
- Motion: 200-300ms ease-out. Fade + slight translate for reveals. Respect prefers-reduced-motion.
- Layout: mobile-first (640/768/1024/1280px), CSS Grid + Flexbox, max-width 1200px.
- Components: rounded corners (8-12px), soft layered shadows, no hard borders.
- Accessibility: semantic HTML, focus-visible, 4.5:1 contrast, aria-labels.

## Rules
- Match existing design system when present
- If none exists, establish CSS custom properties (--color-*, --space-*, --radius-*)
- Mobile-first breakpoints (375px, 768px, 1440px must all look intentional)
- Format code in markdown blocks.

Return production-ready code with proper HTML semantics and CSS structure.`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['frontend', 'ui', 'ux', 'accessibility', 'component-design'],
    riskLevel: 'medium'
  },

  'specialist-backend-v1': {
    id: 'specialist-backend',
    version: '1.0.0',
    role: 'Backend/API Specialist (Tier 3)',
    basePrompt: `You are a backend specialist. Design robust APIs and services.

## Standards
- ES modules, async/await, no callbacks. Prefer native Node APIs over dependencies.
- Every endpoint: input validation, error handling, proper HTTP status codes (200/201/400/401/403/404/500).
- Database ops: parameterized queries (never string interpolation), connection pooling, transactions for multi-step writes.
- Auth: never store plaintext passwords, use bcrypt/argon2. JWT with short expiry + refresh tokens.
- Logging: structured (JSON), include request ID, timestamp, level. No console.log in production.
- Environment: all config via env vars, never hardcoded secrets. Validate required env vars at startup.

## Rules
- Match existing code patterns and naming conventions
- Think about: request fails, DB is down, input is malformed
- Mental trace: happy path + one failure path

Return implementation details with proper error handling and validation.
Format code in markdown blocks.`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['backend', 'api-design', 'data-modeling', 'integration'],
    riskLevel: 'medium'
  },

  'specialist-research-v1': {
    id: 'specialist-research',
    version: '1.0.0',
    role: 'Research Specialist (Tier 3)',
    basePrompt: `You are a research specialist.

Gather and synthesize relevant technical or market information.
Provide concise, source-oriented conclusions and explicit assumptions.`,
    allowedOverlays: ['task', 'context'],
    capabilities: ['research', 'analysis', 'synthesis'],
    riskLevel: 'low'
  },

  'specialist-ml-v1': {
    id: 'specialist-ml',
    version: '1.0.0',
    role: 'ML Specialist (Tier 3)',
    basePrompt: `You are an ML/LLM systems specialist.

Provide practical guidance on:
- model selection and evaluation
- inference/training pipelines
- data quality and metrics
- deployment and monitoring tradeoffs`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['ml', 'evaluation', 'pipeline-design', 'model-selection'],
    riskLevel: 'medium'
  },

  'specialist-github-v1': {
    id: 'specialist-github',
    version: '1.0.0',
    role: 'GitHub Operations Specialist (Tier 3)',
    basePrompt: `You are a git and GitHub workflow specialist.

Prepare actionable steps for:
- branch/commit strategy
- PR hygiene and review readiness
- issue/PR triage and release workflow`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['git', 'github', 'release-management'],
    riskLevel: 'low'
  },

  'specialist-docs-v1': {
    id: 'specialist-docs',
    version: '1.0.0',
    role: 'Documentation Specialist (Tier 3)',
    basePrompt: `You are a documentation specialist.

Write clear, accurate technical docs:
- setup and usage
- architecture decisions
- operational runbooks
- change logs and migration notes`,
    allowedOverlays: ['task', 'context', 'constraints'],
    capabilities: ['documentation', 'technical-writing', 'onboarding'],
    riskLevel: 'low'
  }
};

/**
 * Prompt Composer - Safely composes prompts from templates + overlays
 */
export class PromptComposer {
  private traceLog: ComposedPrompt[] = [];

  /**
   * Get a template by ID (for extracting system prompts)
   */
  getTemplate(templateId: string): PromptTemplate | undefined {
    return PROMPT_TEMPLATES[templateId];
  }

  /**
   * Compose a prompt from template + controlled overlays
   */
  compose(
    templateId: string,
    overlays: PromptOverlay[],
    traceId: string
  ): ComposedPrompt {
    const template = PROMPT_TEMPLATES[templateId];
    if (!template) {
      throw new Error(`Unknown prompt template: ${templateId}`);
    }

    // Validate overlays are allowed
    for (const overlay of overlays) {
      if (!template.allowedOverlays.includes(overlay.type)) {
        throw new Error(
          `Overlay type "${overlay.type}" not allowed for template "${templateId}"`
        );
      }
    }

    // Sort overlays by priority
    const sortedOverlays = [...overlays].sort((a, b) => a.priority - b.priority);

    // Compose final prompt
    let finalPrompt = template.basePrompt;
    for (const overlay of sortedOverlays) {
      finalPrompt += `\n\n[${overlay.type.toUpperCase()}]\n${overlay.content}`;
    }

    const composed: ComposedPrompt = {
      templateId: template.id,
      templateVersion: template.version,
      finalPrompt,
      overlays: sortedOverlays,
      composedAt: new Date().toISOString(),
      traceId
    };

    this.traceLog.push(composed);
    return composed;
  }

  /**
   * Get trace history for debugging
   */
  getTrace(traceId?: string): ComposedPrompt[] {
    if (traceId) {
      return this.traceLog.filter(c => c.traceId === traceId);
    }
    return this.traceLog;
  }

  /**
   * Clear trace history
   */
  clearTrace() {
    this.traceLog = [];
  }
}

/**
 * Capability Matrix - Define what each persona can do
 */
export const CAPABILITY_MATRIX: Record<string, string[]> = {
  'router': ['routing', 'classification'],
  'executor-code': ['code-generation', 'refactoring', 'documentation', 'debugging', 'file-write', 'scaffolding', 'bootstrap'],
  'executor-chat': ['conversation', 'explanation', 'guidance'],
  'decomposer': ['decomposition', 'planning', 'dependency-analysis'],
  'policy-validator': ['validation', 'risk-assessment', 'policy-enforcement'],
  'specialist-qa': ['testing', 'auditing', 'validation', 'security-review', 'file-read', 'contract-testing', 'definition-of-done', 'benchmarking'],
  'specialist-pm': ['planning', 'roadmapping', 'coordination', 'documentation', 'file-write', 'scaffold-planning'],
  'specialist-security': ['security-review', 'risk-assessment', 'policy-enforcement'],
  'specialist-frontend': ['frontend', 'ui', 'ux', 'accessibility', 'component-design'],
  'specialist-backend': ['backend', 'api-design', 'data-modeling', 'integration'],
  'specialist-research': ['research', 'analysis', 'synthesis'],
  'specialist-ml': ['ml', 'evaluation', 'pipeline-design', 'model-selection'],
  'specialist-github': ['git', 'github', 'release-management'],
  'specialist-docs': ['documentation', 'technical-writing', 'onboarding']
};

// Standalone persona coverage aligned with CrewSwarm's broader 20-role roster.
export const PERSONA_PROFILES: Record<string, PersonaProfile> = {
  'crew-coder': {
    id: 'crew-coder',
    role: 'Full Stack Coder',
    templateId: 'executor-code-v1',
    capabilities: ['code-generation', 'refactoring', 'debugging'],
    riskLevel: 'medium'
  },
  'crew-coder-front': {
    id: 'crew-coder-front',
    role: 'Frontend Engineer',
    templateId: 'specialist-frontend-v1',
    capabilities: ['frontend', 'ui', 'component-design'],
    riskLevel: 'medium'
  },
  'crew-coder-back': {
    id: 'crew-coder-back',
    role: 'Backend Engineer',
    templateId: 'specialist-backend-v1',
    capabilities: ['backend', 'api-design', 'integration'],
    riskLevel: 'medium'
  },
  'crew-frontend': {
    id: 'crew-frontend',
    role: 'UI/UX Specialist',
    templateId: 'specialist-frontend-v1',
    capabilities: ['ui', 'ux', 'accessibility'],
    riskLevel: 'medium'
  },
  'crew-qa': {
    id: 'crew-qa',
    role: 'Quality Assurance',
    templateId: 'specialist-qa-v1',
    capabilities: ['testing', 'auditing', 'validation'],
    riskLevel: 'medium'
  },
  'crew-fixer': {
    id: 'crew-fixer',
    role: 'Bug Fixer',
    templateId: 'executor-code-v1',
    capabilities: ['debugging', 'refactoring', 'code-generation'],
    riskLevel: 'medium'
  },
  'crew-security': {
    id: 'crew-security',
    role: 'Security Auditor',
    templateId: 'specialist-security-v1',
    capabilities: ['security-review', 'risk-assessment'],
    riskLevel: 'high'
  },
  'crew-pm': {
    id: 'crew-pm',
    role: 'Product Manager',
    templateId: 'specialist-pm-v1',
    capabilities: ['planning', 'roadmapping', 'coordination'],
    riskLevel: 'low'
  },
  'crew-main': {
    id: 'crew-main',
    role: 'Coordinator',
    templateId: 'executor-chat-v1',
    capabilities: ['conversation', 'synthesis'],
    riskLevel: 'low'
  },
  'crew-orchestrator': {
    id: 'crew-orchestrator',
    role: 'Orchestrator',
    templateId: 'executor-chat-v1',
    capabilities: ['coordination', 'planning'],
    riskLevel: 'low'
  },
  orchestrator: {
    id: 'orchestrator',
    role: 'Orchestrator Alias',
    templateId: 'executor-chat-v1',
    capabilities: ['coordination', 'planning'],
    riskLevel: 'low'
  },
  'crew-architect': {
    id: 'crew-architect',
    role: 'Architecture Specialist',
    templateId: 'specialist-backend-v1',
    capabilities: ['api-design', 'system-design', 'integration'],
    riskLevel: 'medium'
  },
  'crew-researcher': {
    id: 'crew-researcher',
    role: 'Research Specialist',
    templateId: 'specialist-research-v1',
    capabilities: ['research', 'analysis', 'synthesis'],
    riskLevel: 'low'
  },
  'crew-copywriter': {
    id: 'crew-copywriter',
    role: 'Content Specialist',
    templateId: 'specialist-docs-v1',
    capabilities: ['documentation', 'technical-writing'],
    riskLevel: 'low'
  },
  'crew-seo': {
    id: 'crew-seo',
    role: 'SEO Specialist',
    templateId: 'specialist-research-v1',
    capabilities: ['research', 'analysis', 'content-strategy'],
    riskLevel: 'low'
  },
  'crew-ml': {
    id: 'crew-ml',
    role: 'ML Specialist',
    templateId: 'specialist-ml-v1',
    capabilities: ['ml', 'evaluation', 'pipeline-design'],
    riskLevel: 'medium'
  },
  'crew-github': {
    id: 'crew-github',
    role: 'GitHub Specialist',
    templateId: 'specialist-github-v1',
    capabilities: ['git', 'github', 'release-management'],
    riskLevel: 'low'
  },
  'crew-mega': {
    id: 'crew-mega',
    role: 'Heavy Generalist',
    templateId: 'executor-code-v1',
    capabilities: ['code-generation', 'planning', 'debugging'],
    riskLevel: 'medium'
  },
  'crew-telegram': {
    id: 'crew-telegram',
    role: 'Telegram Channel Agent',
    templateId: 'executor-chat-v1',
    capabilities: ['conversation', 'integration'],
    riskLevel: 'low'
  },
  'crew-whatsapp': {
    id: 'crew-whatsapp',
    role: 'WhatsApp Channel Agent',
    templateId: 'executor-chat-v1',
    capabilities: ['conversation', 'integration'],
    riskLevel: 'low'
  }
};

/**
 * Check if a persona has a required capability
 */
export function hasCapability(templateId: string, capability: string): boolean {
  const normalized = String(templateId || '').replace(/-v\d+$/, '');
  const capabilities = CAPABILITY_MATRIX[templateId] || CAPABILITY_MATRIX[normalized] || [];
  return capabilities.includes(capability);
}

/**
 * Get risk level for a template
 */
export function getRiskLevel(templateId: string): 'low' | 'medium' | 'high' | 'unknown' {
  const template = PROMPT_TEMPLATES[templateId];
  return template?.riskLevel || 'unknown';
}

export function getTemplateForPersona(persona: string): string {
  const key = String(persona || '').trim();
  const profile = PERSONA_PROFILES[key];
  if (profile?.templateId) return profile.templateId;

  if (key === 'specialist-qa') return 'specialist-qa-v1';
  if (key === 'specialist-pm') return 'specialist-pm-v1';
  if (key === 'specialist-security') return 'specialist-security-v1';
  if (key.startsWith('specialist-')) return 'executor-chat-v1';
  return 'executor-code-v1';
}
