import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitHubIntent =
  | { kind: 'issue_list'; state: 'open' | 'closed' | 'all'; limit: number }
  | { kind: 'issue_create'; title: string; body: string }
  | { kind: 'issue_update'; number: number; title?: string; body?: string; state?: 'open' | 'closed' }
  | { kind: 'pr_list'; state: 'open' | 'closed' | 'merged'; limit: number }
  | { kind: 'pr_draft'; title: string; body: string; base?: string; head?: string }
  | { kind: 'unknown'; reason: string };

export interface ParseGitHubIntentOptions {
  defaultLimit?: number;
}

function readQuoted(text: string): string {
  const m = text.match(/"([^"]+)"/);
  return (m?.[1] || '').trim();
}

function readAfter(text: string, marker: string): string {
  const idx = text.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) return '';
  return text.slice(idx + marker.length).trim();
}

function parseLimit(text: string, fallback: number): number {
  const m = text.match(/\b(?:limit|top|first)\s+(\d+)\b/i);
  if (!m) return fallback;
  const value = Number.parseInt(m[1], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseGitHubIntent(input: string, options: ParseGitHubIntentOptions = {}): GitHubIntent {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  const defaultLimit = Math.max(1, Number(options.defaultLimit || 10));

  if (!text) return { kind: 'unknown', reason: 'Empty request.' };

  if ((/\b(list|show|get)\b/.test(lower) && /\bissues?\b/.test(lower)) || lower.startsWith('issues')) {
    const state = lower.includes('closed') ? 'closed' : lower.includes('all') ? 'all' : 'open';
    return { kind: 'issue_list', state, limit: parseLimit(text, defaultLimit) };
  }

  if ((/\b(list|show|get)\b/.test(lower) && /\b(pr|pull request|pull requests)\b/.test(lower)) || lower.startsWith('prs')) {
    const state = lower.includes('merged')
      ? 'merged'
      : lower.includes('closed')
        ? 'closed'
        : 'open';
    return { kind: 'pr_list', state, limit: parseLimit(text, defaultLimit) };
  }

  if (/\b(update|edit|close|reopen)\b/.test(lower) && /\bissue\b/.test(lower)) {
    const num = text.match(/#(\d+)/)?.[1] || text.match(/\bissue\s+(\d+)\b/i)?.[1];
    if (!num) return { kind: 'unknown', reason: 'Issue update requires an issue number (e.g. #123).' };
    const parsedNumber = Number.parseInt(num, 10);
    const title = readQuoted(text);
    const body = readAfter(text, 'body:');
    let state: 'open' | 'closed' | undefined;
    if (/\bclose\b/.test(lower)) state = 'closed';
    if (/\breopen\b/.test(lower)) state = 'open';
    return {
      kind: 'issue_update',
      number: parsedNumber,
      title: title || undefined,
      body: body || undefined,
      state
    };
  }

  if ((/\b(create|open|file)\b/.test(lower) && /\bissue\b/.test(lower)) || lower.startsWith('issue create')) {
    const quoted = readQuoted(text);
    const title = quoted || readAfter(text, 'issue').replace(/^create\s*/i, '').trim();
    const body = readAfter(text, 'body:');
    if (!title) return { kind: 'unknown', reason: 'Issue create requires a title (quote it for best parsing).' };
    return { kind: 'issue_create', title, body: body || '' };
  }

  if (/\b(create|open|draft)\b/.test(lower) && /\b(pr|pull request)\b/.test(lower)) {
    const title = readQuoted(text) || readAfter(text, 'pr').replace(/^create\s*/i, '').trim();
    const body = readAfter(text, 'body:');
    const base = text.match(/\bbase:([A-Za-z0-9_./-]+)/i)?.[1];
    const head = text.match(/\bhead:([A-Za-z0-9_./-]+)/i)?.[1];
    if (!title) return { kind: 'unknown', reason: 'Draft PR create requires a title (quote it for best parsing).' };
    return { kind: 'pr_draft', title, body: body || '', base, head };
  }

  return { kind: 'unknown', reason: 'Could not infer GitHub action. Try list/create/update issue or list/create PR.' };
}

async function runGh(args: string[], cwd = process.cwd()): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      maxBuffer: 1024 * 1024 * 8
    });
    const out = String(stdout || '').trim();
    const err = String(stderr || '').trim();
    return out || err;
  } catch (error) {
    const message = String((error as any)?.stderr || (error as Error).message || error);
    if (/enoent|not found/i.test(message)) {
      throw new Error('GitHub CLI (gh) not found. Install gh and run `gh auth login`.');
    }
    throw new Error(message.trim() || 'GitHub command failed');
  }
}

export interface ExecuteGitHubIntentOptions {
  cwd?: string;
  repo?: string;
}

export function buildGitHubCommand(intent: GitHubIntent, repo?: string): string[] {
  const repoArgs = repo ? ['--repo', repo] : [];

  if (intent.kind === 'issue_list') {
    return ['issue', 'list', '--state', intent.state, '--limit', String(intent.limit), '--json', 'number,title,state,url', ...repoArgs];
  }
  if (intent.kind === 'pr_list') {
    return ['pr', 'list', '--state', intent.state, '--limit', String(intent.limit), '--json', 'number,title,state,url', ...repoArgs];
  }
  if (intent.kind === 'issue_create') {
    return ['issue', 'create', '--title', intent.title, '--body', intent.body || '', ...repoArgs];
  }
  if (intent.kind === 'issue_update') {
    const args = ['issue', 'edit', String(intent.number), ...repoArgs];
    if (intent.title) args.push('--title', intent.title);
    if (intent.body) args.push('--body', intent.body);
    if (intent.state) args.push('--state', intent.state);
    return args;
  }
  if (intent.kind === 'pr_draft') {
    const args = ['pr', 'create', '--draft', '--title', intent.title, '--body', intent.body || '', ...repoArgs];
    if (intent.base) args.push('--base', intent.base);
    if (intent.head) args.push('--head', intent.head);
    return args;
  }
  throw new Error(intent.reason || 'Unknown GitHub request');
}

export function commandToShell(args: string[]): string {
  const q = (value: string) => {
    if (!/[\s"'$`\\]/.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
  };
  return `gh ${args.map(q).join(' ')}`;
}

export async function executeGitHubIntent(intent: GitHubIntent, options: ExecuteGitHubIntentOptions = {}): Promise<string> {
  const cwd = options.cwd || process.cwd();
  const args = buildGitHubCommand(intent, options.repo);
  return runGh(args, cwd);
}

export function requiresConfirmation(intent: GitHubIntent): boolean {
  return intent.kind === 'issue_create' || intent.kind === 'issue_update' || intent.kind === 'pr_draft';
}

export function describeIntent(intent: GitHubIntent): string {
  if (intent.kind === 'issue_list') return `List ${intent.state} issues (limit ${intent.limit})`;
  if (intent.kind === 'pr_list') return `List ${intent.state} PRs (limit ${intent.limit})`;
  if (intent.kind === 'issue_create') return `Create issue: "${intent.title}"`;
  if (intent.kind === 'issue_update') return `Update issue #${intent.number}`;
  if (intent.kind === 'pr_draft') return `Create draft PR: "${intent.title}"`;
  return `Unknown: ${intent.reason}`;
}

export interface GitHubDoctorCheck {
  name: string;
  ok: boolean;
  details: string;
}

export async function runGitHubDoctor(cwd = process.cwd(), repo?: string): Promise<GitHubDoctorCheck[]> {
  const checks: GitHubDoctorCheck[] = [];
  try {
    const { stdout } = await execFileAsync('gh', ['--version'], { cwd, maxBuffer: 1024 * 1024 });
    checks.push({
      name: 'gh installed',
      ok: true,
      details: String(stdout || '').split('\n')[0] || 'ok'
    });
  } catch (error) {
    checks.push({
      name: 'gh installed',
      ok: false,
      details: /enoent|not found/i.test(String((error as any)?.message || ''))
        ? 'gh not found in PATH'
        : String((error as Error).message || error)
    });
    checks.push({
      name: 'gh auth status',
      ok: false,
      details: 'skipped (gh missing)'
    });
    checks.push({
      name: 'repo access baseline',
      ok: false,
      details: 'skipped (gh missing)'
    });
    return checks;
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], {
      cwd,
      maxBuffer: 1024 * 1024
    });
    const info = String(stdout || stderr || '').trim();
    checks.push({
      name: 'gh auth status',
      ok: true,
      details: info.split('\n')[0] || 'authenticated'
    });
  } catch (error) {
    checks.push({
      name: 'gh auth status',
      ok: false,
      details: String((error as any)?.stderr || (error as Error).message || error).trim()
    });
  }

  const repoArgs = repo ? ['--repo', repo] : [];
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', ...repoArgs, '--json', 'nameWithOwner,viewerPermission'],
      { cwd, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(String(stdout || '{}'));
    const perm = String(parsed.viewerPermission || 'unknown');
    const name = String(parsed.nameWithOwner || repo || '(current)');
    checks.push({
      name: 'repo access baseline',
      ok: true,
      details: `${name} (${perm})`
    });
  } catch (error) {
    checks.push({
      name: 'repo access baseline',
      ok: false,
      details: String((error as any)?.stderr || (error as Error).message || error).trim()
    });
  }

  return checks;
}
