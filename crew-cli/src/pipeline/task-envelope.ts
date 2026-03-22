import type { WorkGraph, WorkUnit } from '../prompts/dual-l2.js';

export interface WorkerTaskEnvelope {
  id: string;
  goal: string;
  persona: string;
  dependencies: string[];
  allowedPaths: string[];
  verification: string[];
  requiredCapabilities: string[];
  sourceRefs?: string[];
  estimatedComplexity?: 'low' | 'medium' | 'high';
  escalationHints?: string[];
  maxFilesTouched?: number;
}

export interface WorkerTaskValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const FILE_PATH_RE = /(?:^|[\s(])((?:\.{0,2}\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)\b/g;
const CANONICAL_SOURCE_RE = /^(PDD|ROADMAP|ARCH|CONTRACT-TESTS|DOD|SCAFFOLD|GOLDEN-BENCHMARKS)\.md#/;
const BROAD_SCOPE_RE = /\b(entire|whole|all files|entire project|whole project|entire codebase|everything)\b/i;
const ACTION_VERB_RE = /\b(add|build|create|edit|fix|implement|refactor|remove|rename|replace|update|verify|write)\b/i;

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function extractPaths(text: string): string[] {
  const matches: string[] = [];
  let match;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const raw = String(match[1] || '').trim();
    if (!raw) continue;
    matches.push(raw.replace(/[),.;:]+$/, ''));
  }
  return unique(matches);
}

function defaultVerification(unit: WorkUnit, allowedPaths: string[]): string[] {
  const checks: string[] = [];
  if (allowedPaths.length > 0) {
    checks.push(`Confirm the requested changes exist in: ${allowedPaths.join(', ')}`);
  }
  checks.push('Report the exact files changed.');
  if ((unit.requiredCapabilities || []).includes('testing')) {
    checks.push('Run the relevant test or validation command and report the result.');
  }
  return checks;
}

function defaultEscalationHints(unit: WorkUnit, allowedPaths: string[]): string[] {
  const hints: string[] = [];
  if (allowedPaths.length === 0) {
    hints.push('Escalate if the required file paths are ambiguous.');
  }
  if (unit.estimatedComplexity === 'high') {
    hints.push('Escalate if the task expands beyond the stated scope or requires architectural decisions.');
  }
  hints.push('Escalate after two failed attempts on the same verification step.');
  return hints;
}

export function createWorkerTaskEnvelope(unit: WorkUnit): WorkerTaskEnvelope {
  const allowedPaths = Array.isArray(unit.allowedPaths) && unit.allowedPaths.length > 0
    ? unique(unit.allowedPaths.map(String))
    : extractPaths(unit.description || '');
  const verification = Array.isArray(unit.verification) && unit.verification.length > 0
    ? unique(unit.verification.map(String))
    : defaultVerification(unit, allowedPaths);

  const envelope: WorkerTaskEnvelope = {
    id: unit.id,
    goal: unit.description,
    persona: unit.requiredPersona,
    dependencies: Array.isArray(unit.dependencies) ? unit.dependencies : [],
    allowedPaths,
    verification,
    requiredCapabilities: Array.isArray(unit.requiredCapabilities) ? unit.requiredCapabilities : [],
  };

  // Only populate optional advisory fields when there's actual data
  const sourceRefs = Array.isArray(unit.sourceRefs) ? unit.sourceRefs.map(String).filter(Boolean) : [];
  if (sourceRefs.length > 0) {
    envelope.sourceRefs = sourceRefs;
  }

  if (unit.estimatedComplexity && ['low', 'medium', 'high'].includes(unit.estimatedComplexity)) {
    envelope.estimatedComplexity = unit.estimatedComplexity;
  }

  const escalationHints = Array.isArray(unit.escalationHints) && unit.escalationHints.length > 0
    ? unique(unit.escalationHints.map(String))
    : defaultEscalationHints(unit, allowedPaths);
  if (escalationHints.length > 0) {
    envelope.escalationHints = escalationHints;
  }

  if (typeof unit.maxFilesTouched === 'number' && Number.isFinite(unit.maxFilesTouched) && unit.maxFilesTouched > 0) {
    envelope.maxFilesTouched = Math.floor(unit.maxFilesTouched);
  } else if (allowedPaths.length > 0) {
    envelope.maxFilesTouched = allowedPaths.length;
  }

  return envelope;
}

export function validateWorkerTaskEnvelope(task: WorkerTaskEnvelope): WorkerTaskValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!String(task.id || '').trim()) errors.push('task.id missing');
  if (!String(task.goal || '').trim()) errors.push('task.goal missing');
  if (!String(task.persona || '').trim()) errors.push('task.persona missing');
  if (!Array.isArray(task.dependencies)) errors.push('task.dependencies must be array');
  if (!Array.isArray(task.allowedPaths)) errors.push('task.allowedPaths must be array');
  if (!Array.isArray(task.verification) || task.verification.length === 0) errors.push('task.verification missing');
  if (!Array.isArray(task.requiredCapabilities)) errors.push('task.requiredCapabilities must be array');
  if (task.sourceRefs !== undefined && !Array.isArray(task.sourceRefs)) errors.push('task.sourceRefs must be array if provided');
  if (task.maxFilesTouched !== undefined && (typeof task.maxFilesTouched !== 'number' || !Number.isFinite(task.maxFilesTouched) || task.maxFilesTouched < 1)) {
    errors.push('task.maxFilesTouched invalid');
  }
  if (task.estimatedComplexity !== undefined && !['low', 'medium', 'high'].includes(String(task.estimatedComplexity || ''))) {
    errors.push('task.estimatedComplexity invalid');
  }
  const goal = String(task.goal || '').trim();
  if (goal.length < 20) errors.push('task.goal too short');
  if (!ACTION_VERB_RE.test(goal)) warnings.push('task.goal may be too vague; no concrete action verb found');
  if (BROAD_SCOPE_RE.test(goal)) {
    // Ad-hoc tasks from raw user input may contain broad language — warn, don't reject
    if (task.sourceRefs?.includes('adhoc#request') || task.sourceRefs?.includes('request#user-input')) {
      warnings.push('task.goal may be too broad for a single worker');
    } else {
      errors.push('task.goal too broad');
    }
  }
  if (task.estimatedComplexity && task.estimatedComplexity !== 'low' && task.allowedPaths.length === 0) {
    warnings.push('task.allowedPaths empty for non-trivial task');
  }
  if (task.allowedPaths.length > 3) {
    warnings.push('task.allowedPaths spans more than 3 paths; consider decomposing further');
  }
  if (task.maxFilesTouched && task.maxFilesTouched > 3 && task.estimatedComplexity !== 'high') {
    warnings.push('task.maxFilesTouched > 3 for non-high-complexity task');
  }
  if (task.verification.length > 5) {
    warnings.push('task.verification has many checks; consider splitting the task');
  }
  if (Array.isArray(task.sourceRefs) && task.sourceRefs.length > 0) {
    const invalidSourceRefs = task.sourceRefs.filter(ref => !CANONICAL_SOURCE_RE.test(String(ref)));
    if (invalidSourceRefs.length > 0) {
      warnings.push(`task.sourceRefs include non-canonical refs: ${invalidSourceRefs.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function buildWorkerTasks(workGraph: WorkGraph): WorkerTaskEnvelope[] {
  return (workGraph.units || []).map(createWorkerTaskEnvelope);
}

export function createAdHocWorkerTask(input: {
  id: string;
  goal: string;
  persona?: string;
  sourceRefs?: string[];
  estimatedComplexity?: 'low' | 'medium' | 'high';
  requiredCapabilities?: string[];
  maxFilesTouched?: number;
}): WorkerTaskEnvelope {
  const goal = String(input.goal || '').trim();
  const allowedPaths = extractPaths(goal);
  const sourceRefs = Array.isArray(input.sourceRefs) && input.sourceRefs.length > 0
    ? input.sourceRefs.map(String)
    : ['adhoc#request'];
  const requiredCapabilities = Array.isArray(input.requiredCapabilities) && input.requiredCapabilities.length > 0
    ? input.requiredCapabilities.map(String)
    : ['code-generation'];
  return {
    id: input.id,
    goal,
    persona: input.persona || 'executor-code',
    dependencies: [],
    allowedPaths,
    verification: [
      ...(allowedPaths.length > 0 ? [`Confirm the requested changes exist in: ${allowedPaths.join(', ')}`] : []),
      'Report the exact files changed.',
      'Run relevant verification if code was modified.'
    ],
    requiredCapabilities,
    sourceRefs,
    estimatedComplexity: input.estimatedComplexity || 'medium',
    escalationHints: [
      ...(allowedPaths.length === 0 ? ['Escalate if the file scope is ambiguous.'] : []),
      'Escalate after two failed attempts on the same verification step.'
    ],
    maxFilesTouched: typeof input.maxFilesTouched === 'number' && Number.isFinite(input.maxFilesTouched) && input.maxFilesTouched > 0
      ? Math.floor(input.maxFilesTouched)
      : Math.max(1, allowedPaths.length || 1)
  };
}
