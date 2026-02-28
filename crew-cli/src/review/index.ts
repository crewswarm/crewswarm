import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function clip(text: string, maxChars = 20000): string {
  if (!text) return '(none)';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim();
}

export async function getReviewPayload(cwd = process.cwd()): Promise<{ hasChanges: boolean; payload: string }> {
  try {
    const [branch, unstaged, staged, status, commits] = await Promise.all([
      runGit(['branch', '--show-current'], cwd).catch(() => '(unknown)'),
      runGit(['diff', '--no-ext-diff'], cwd).catch(() => ''),
      runGit(['diff', '--staged', '--no-ext-diff'], cwd).catch(() => ''),
      runGit(['status', '--short'], cwd).catch(() => '(unavailable)'),
      runGit(['log', '-5', '--oneline'], cwd).catch(() => '(unavailable)')
    ]);

    const hasChanges = Boolean(unstaged || staged);
    const payload = [
      'Please review this git diff before commit. Focus on regressions, missing tests, and risky behavior changes.',
      '',
      '## Branch',
      branch || '(detached)',
      '',
      '## Status',
      '```text',
      status || '(clean)',
      '```',
      '',
      '## Recent commits',
      '```text',
      commits || '(none)',
      '```',
      '',
      '## Unstaged diff',
      '```diff',
      clip(unstaged),
      '```',
      '',
      '## Staged diff',
      '```diff',
      clip(staged),
      '```'
    ].join('\n');

    return { hasChanges, payload };
  } catch (error) {
    return { hasChanges: false, payload: `Unable to collect review payload: ${(error as Error).message}` };
  }
}
