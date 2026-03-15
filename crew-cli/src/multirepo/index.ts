import { readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RepoSummary {
  name: string;
  path: string;
  branch: string;
  statusShort: string;
  recentCommit: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 1024 * 1024 * 2
  });
  return stdout.trim();
}

export async function findSiblingRepos(baseDir = process.cwd()): Promise<string[]> {
  const abs = resolve(baseDir);
  const parent = dirname(abs);
  const currentName = abs.split('/').pop() || '';
  const entries = await readdir(parent, { withFileTypes: true });

  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentName) continue;
    const repoPath = join(parent, entry.name);
    if (await exists(join(repoPath, '.git'))) {
      repos.push(repoPath);
    }
  }
  return repos;
}

export async function getRepoSummary(repoPath: string): Promise<RepoSummary> {
  const [branch, statusShort, recentCommit] = await Promise.all([
    runGit(repoPath, ['branch', '--show-current']).catch(() => '(unknown)'),
    runGit(repoPath, ['status', '--short']).catch(() => ''),
    runGit(repoPath, ['log', '-1', '--oneline']).catch(() => '(none)')
  ]);

  return {
    name: repoPath.split('/').pop() || repoPath,
    path: repoPath,
    branch: branch || '(detached)',
    statusShort: statusShort || '(clean)',
    recentCommit
  };
}

export async function collectMultiRepoContext(baseDir = process.cwd()): Promise<string> {
  const siblings = await findSiblingRepos(baseDir);
  if (siblings.length === 0) {
    return '## Cross-Repo Context\n```text\nNo sibling git repositories found.\n```';
  }

  const summaries = await Promise.all(siblings.map(path => getRepoSummary(path)));
  const lines = summaries.flatMap(summary => [
    `${summary.name} (${summary.path})`,
    `  branch: ${summary.branch}`,
    `  recent: ${summary.recentCommit}`,
    `  status: ${summary.statusShort}`,
    ''
  ]);

  return ['## Cross-Repo Context', '```text', ...lines, '```'].join('\n');
}

export async function syncRepoSnapshots(baseDir = process.cwd()): Promise<string> {
  const siblings = await findSiblingRepos(baseDir);
  const summaries = await Promise.all(siblings.map(path => getRepoSummary(path)));
  const outDir = join(baseDir, '.crew');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'multi-repo-sync.json');
  await writeFile(
    outPath,
    JSON.stringify({ syncedAt: new Date().toISOString(), repos: summaries }, null, 2),
    'utf8'
  );
  return outPath;
}

export async function detectBreakingApiSignals(repoPath: string): Promise<string[]> {
  const changedFilesRaw = await runGit(repoPath, ['diff', '--name-only']).catch(() => '');
  const changedFiles = changedFilesRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const warnings: string[] = [];

  for (const file of changedFiles) {
    if (/(api|route|routes|schema|openapi|proto|graphql|types?)/i.test(file)) {
      warnings.push(`Potential API-impacting file changed: ${file}`);
    }
  }

  const diffText = await runGit(repoPath, ['diff']).catch(() => '');
  const removedExports = (diffText.match(/^-.*export\s+(interface|type|class|function)\s+/gm) || []).length;
  if (removedExports > 0) {
    warnings.push(`Detected ${removedExports} removed exported symbols.`);
  }

  const removedRoutes = (diffText.match(/^-.*(app\.(get|post|put|delete)|router\.(get|post|put|delete))/gm) || []).length;
  if (removedRoutes > 0) {
    warnings.push(`Detected ${removedRoutes} removed route handlers.`);
  }

  return warnings;
}
