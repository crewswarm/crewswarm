/**
 * Summon — runtime sub-agent delegation.
 *
 * Unlike spawn_agent (which starts a new autonomous loop), summon
 * dynamically loads a specialized persona mid-execution and delegates
 * a sub-task to it. The sub-agent runs with:
 *   - A persona-specific system prompt
 *   - A filtered tool set appropriate for its role
 *   - Access to the current sandbox state
 *   - Budget/turn limits from the parent
 *
 * This enables runtime persona switching without the overhead of
 * starting a full new agent session.
 *
 * Usage from the LLM:
 *   summon({ persona: "crew-qa", task: "write tests for src/auth.ts" })
 */

import type { Sandbox } from '../sandbox/index.js';
import { filterToolsForTask, type ToolDeclarationLike } from './tool-filter.js';

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------

export interface PersonaConfig {
  id: string;
  name: string;
  systemPromptAddition: string;
  defaultMaxTurns: number;
  toolDomains: string[];
}

const PERSONAS: Record<string, PersonaConfig> = {
  'crew-qa': {
    id: 'crew-qa',
    name: 'QA Specialist',
    systemPromptAddition: `You are a QA specialist. Your primary focus is:
- Writing comprehensive test cases
- Verifying code correctness
- Running test suites and analyzing failures
- Checking edge cases and error handling
- Ensuring test coverage for all modified code
Always run tests after writing them to verify they pass.`,
    defaultMaxTurns: 8,
    toolDomains: ['coding', 'testing']
  },
  'crew-coder-back': {
    id: 'crew-coder-back',
    name: 'Backend Specialist',
    systemPromptAddition: `You are a backend specialist. Your primary focus is:
- API design and implementation (REST, GraphQL)
- Database operations and data modeling
- Authentication and authorization
- Input validation and error handling
- Performance and security best practices
Prefer minimal, well-typed implementations. Validate at boundaries.`,
    defaultMaxTurns: 10,
    toolDomains: ['coding', 'testing']
  },
  'crew-coder-front': {
    id: 'crew-coder-front',
    name: 'Frontend Specialist',
    systemPromptAddition: `You are a frontend specialist. Your primary focus is:
- UI component implementation
- Responsive layouts and CSS
- Accessibility (WCAG AA compliance)
- State management and data flow
- Performance optimization (bundle size, render cycles)
Follow the DESIGN.md design system if available. Use semantic HTML.`,
    defaultMaxTurns: 10,
    toolDomains: ['coding', 'research']
  },
  'crew-security': {
    id: 'crew-security',
    name: 'Security Reviewer',
    systemPromptAddition: `You are a security specialist. Your primary focus is:
- Identifying injection vulnerabilities (SQL, XSS, command)
- Reviewing authentication and authorization logic
- Checking for secrets/credentials in code
- Input validation and sanitization
- OWASP Top 10 compliance
Report findings with severity (critical/high/medium/low) and fix guidance.`,
    defaultMaxTurns: 6,
    toolDomains: ['coding']
  },
  'crew-copywriter': {
    id: 'crew-copywriter',
    name: 'Documentation Writer',
    systemPromptAddition: `You are a technical writer. Your primary focus is:
- Clear, concise documentation
- API documentation with examples
- README files with install/usage/contributing sections
- Code comments only where logic isn't self-evident
- Changelog entries
Write for developers. Lead with examples, not explanations.`,
    defaultMaxTurns: 6,
    toolDomains: ['coding', 'docs']
  },
  'crew-fixer': {
    id: 'crew-fixer',
    name: 'Bug Fixer',
    systemPromptAddition: `You are a debugging specialist. Your primary focus is:
- Reading error messages and stack traces carefully
- Identifying root causes, not just symptoms
- Making minimal, targeted fixes
- Verifying the fix doesn't introduce regressions
- Running the failing test/command after fixing
Never guess — read the code first. Fix one thing at a time.`,
    defaultMaxTurns: 8,
    toolDomains: ['coding', 'testing']
  }
};

// ---------------------------------------------------------------------------
// Summon interface
// ---------------------------------------------------------------------------

export interface SummonOptions {
  persona: string;
  task: string;
  maxTurns?: number;
  /** Parent context to pass to the sub-agent */
  context?: string;
  /** Budget limit inherited from parent */
  maxBudgetUsd?: number;
}

export interface SummonResult {
  persona: string;
  task: string;
  success: boolean;
  output: string;
  turns: number;
  cost: number;
  toolsUsed: string[];
}

/**
 * Get a persona configuration by ID.
 */
export function getPersona(id: string): PersonaConfig | undefined {
  return PERSONAS[id];
}

/**
 * List all available personas.
 */
export function listPersonas(): PersonaConfig[] {
  return Object.values(PERSONAS);
}

/**
 * Build a system prompt for a summoned sub-agent.
 */
export function buildSummonPrompt(
  basePrompt: string,
  persona: PersonaConfig,
  parentContext?: string
): string {
  const parts = [basePrompt, persona.systemPromptAddition];
  if (parentContext) {
    parts.push(`\n## Parent context:\n${parentContext}`);
  }
  return parts.join('\n\n');
}

/**
 * Filter tools for a summoned persona based on its domains.
 */
export function filterToolsForPersona<T extends ToolDeclarationLike>(
  tools: T[],
  persona: PersonaConfig
): T[] {
  // Build a fake task that includes domain keywords
  const domainKeywords: Record<string, string> = {
    coding: 'write code files',
    testing: 'run tests verify',
    research: 'search web fetch',
    git: 'git commit branch',
    docs: 'documentation readme',
    planning: 'plan roadmap architect'
  };
  const fakeTask = persona.toolDomains.map(d => domainKeywords[d] || d).join(' ');
  return filterToolsForTask(tools, fakeTask);
}
