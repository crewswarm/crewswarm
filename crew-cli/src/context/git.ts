import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRepositoryMap } from '../mapping/index.js';

const execFileAsync = promisify(execFile);

export interface GitContextOptions {
  maxDiffChars?: number;
}

export interface GitChangedFilesOptions {
  maxFiles?: number;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 4
  });
  return stdout.trim();
}

function clip(text: string, maxChars: number): string {
  if (!text) {
    return '(none)';
  }

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

export async function getProjectContext(
  cwd: string = process.cwd(),
  options: GitContextOptions = {}
): Promise<string> {
  const maxDiffChars = Number.isInteger(options.maxDiffChars) ? (options.maxDiffChars as number) : 6000;
  
  let tree = '(unavailable)';
  try {
    tree = await buildRepositoryMap(cwd);
  } catch (err) {
    // Ignore
  }

  try {
    const insideWorkTree = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (insideWorkTree !== 'true') {
      return `## Repository Context\n\`\`\`text\n${tree}\n\`\`\`\n\n## Git Context\n\`\`\`text\nNo git repository detected.\n\`\`\``;
    }
  } catch {
    return `## Repository Context\n\`\`\`text\n${tree}\n\`\`\`\n\n## Git Context\n\`\`\`text\nNo git repository detected.\n\`\`\``;
  }

  const [branch, status, unstagedDiff, stagedDiff, log] = await Promise.all([
    runGit(['branch', '--show-current'], cwd).catch(() => '(unknown)'),
    runGit(['status', '--short'], cwd).catch(() => '(unavailable)'),
    runGit(['diff', '--no-ext-diff'], cwd).catch(() => '(unavailable)'),
    runGit(['diff', '--staged', '--no-ext-diff'], cwd).catch(() => '(unavailable)'),
    runGit(['log', '-5', '--oneline'], cwd).catch(() => '(unavailable)')
  ]);

  return [
    '## Repository Context',
    '```text',
    clip(tree, 8000),
    '```',
    '',
    '## Git Context',
    '```text',
    `Branch: ${branch || '(detached HEAD)'}`,
    '',
    'Status (--short):',
    status || '(clean)',
    '',
    'Recent commits (last 5):',
    log || '(none)',
    '',
    'Unstaged diff:',
    clip(unstagedDiff, maxDiffChars),
    '',
    'Staged diff:',
    clip(stagedDiff, maxDiffChars),
    '```'
  ].join('\n');
}

export async function getChangedFiles(
  cwd: string = process.cwd(),
  options: GitChangedFilesOptions = {}
): Promise<string[]> {
  const maxFiles = Number.isInteger(options.maxFiles) ? (options.maxFiles as number) : 80;
  try {
    const insideWorkTree = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (insideWorkTree !== 'true') return [];
  } catch {
    return [];
  }

  try {
    const status = await runGit(['status', '--short'], cwd);
    if (!status) return [];
    const files = status
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^[A-Z?]{1,2}\s+/, '').trim())
      .filter(Boolean);
    return files.slice(0, Math.max(1, maxFiles));
  } catch {
    return [];
  }
}
