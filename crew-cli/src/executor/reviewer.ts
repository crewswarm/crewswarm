import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LocalExecutor } from './local.js';

export interface ReviewIssue {
  severity: 'low' | 'medium' | 'high';
  problem: string;
  requiredFix: string;
}

export interface ReviewResult {
  approved: boolean;
  severity: 'low' | 'medium' | 'high';
  summary: string;
  issues: ReviewIssue[];
  model?: string;
  cost: number;
  raw: string;
}

export interface ReviewInput {
  executor: LocalExecutor;
  model?: string;
  sessionId?: string;
  projectDir: string;
  projectContextSummary?: string;
  workUnitId: string;
  persona: string;
  taskGoal: string;
  workerOutput: string;
  filesChanged: string[];
  verification: string[];
  shellResults?: Array<{ command: string; exitCode: number; output: string }>;
  stagedContentForPath?: (filePath: string) => string | undefined;
}

async function loadFileSnippets(input: ReviewInput): Promise<string> {
  const snippets: string[] = [];
  let chars = 0;
  const limit = Number(process.env.CREW_L3_REVIEW_SNIPPET_CHARS || 6000);

  for (const relPath of input.filesChanged.slice(0, 4)) {
    try {
      const staged = input.stagedContentForPath?.(relPath);
      const content = staged ?? await readFile(resolve(input.projectDir, relPath), 'utf8');
      const trimmed = content.slice(0, 1800);
      if (chars + trimmed.length > limit) break;
      snippets.push(`## ${relPath}\n\`\`\`\n${trimmed}\n\`\`\``);
      chars += trimmed.length;
    } catch {
      // Best-effort review context only.
    }
  }

  return snippets.join('\n\n');
}

function normalizeSeverity(raw: unknown): 'low' | 'medium' | 'high' {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'low';
}

export async function reviewWorkerExecution(input: ReviewInput): Promise<ReviewResult> {
  const fileSnippets = await loadFileSnippets(input);
  const prompt = [
    'Review this worker result for correctness against the requested task.',
    'Focus on implementation bugs, stack mismatches, obvious regressions, missing requirements, and unsafe changes.',
    'Prefer concrete issues over style feedback.',
    '',
    input.projectContextSummary ? `Project context:\n${input.projectContextSummary}` : '',
    `Work unit: ${input.workUnitId}`,
    `Persona: ${input.persona}`,
    `Task:\n${input.taskGoal}`,
    '',
    `Files changed: ${input.filesChanged.join(', ') || '(none)'}`,
    `Verification: ${input.verification.join(' | ') || '(none)'}`,
    `Shell results: ${JSON.stringify(input.shellResults || [])}`,
    '',
    `Worker output:\n${input.workerOutput}`,
    '',
    fileSnippets ? `Changed file snippets:\n${fileSnippets}` : '',
    '',
    'Return ONLY valid JSON:',
    '{',
    '  "approved": true,',
    '  "severity": "low|medium|high",',
    '  "summary": "short summary",',
    '  "issues": [',
    '    {',
    '      "severity": "low|medium|high",',
    '      "problem": "what is wrong",',
    '      "requiredFix": "specific fix guidance"',
    '    }',
    '  ]',
    '}',
    '',
    'Approve when the code appears correct and aligned with the task. Reject if there are concrete defects or requirement misses.'
  ].filter(Boolean).join('\n');

  const result = await input.executor.execute(prompt, {
    model: input.model,
    temperature: 0,
    maxTokens: 1800,
    jsonMode: true,
    sessionId: input.sessionId
  });

  const raw = String(result.result || '').trim();
  try {
    const parsed = JSON.parse(raw);
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map((issue: any) => ({
          severity: normalizeSeverity(issue?.severity),
          problem: String(issue?.problem || '').trim(),
          requiredFix: String(issue?.requiredFix || '').trim()
        })).filter((issue: ReviewIssue) => issue.problem && issue.requiredFix)
      : [];

    return {
      approved: Boolean(parsed.approved),
      severity: normalizeSeverity(parsed.severity),
      summary: String(parsed.summary || '').trim() || (issues.length === 0 ? 'Approved' : 'Issues found'),
      issues,
      model: result.model,
      cost: Number(result.costUsd || 0),
      raw
    };
  } catch {
    const lower = raw.toLowerCase();
    const approved = lower.includes('approved') && !lower.includes('not approved') && !lower.includes('reject');
    return {
      approved,
      severity: approved ? 'low' : 'medium',
      summary: approved ? 'Reviewer returned non-JSON approval text' : 'Reviewer returned non-JSON rejection text',
      issues: approved ? [] : [{
        severity: 'medium',
        problem: 'Reviewer response was not valid JSON.',
        requiredFix: 'Re-run review or inspect the worker output manually.'
      }],
      model: result.model,
      cost: Number(result.costUsd || 0),
      raw
    };
  }
}
