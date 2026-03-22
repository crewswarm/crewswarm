/**
 * Project Structure Analyzer
 * Provides lightweight project structure context for L3 worker execution briefs.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

interface StructureResult {
  language: string;
  framework: string;
  entryPoints: string[];
  directories: string[];
  fileCount: number;
  hasTests: boolean;
  hasConfig: boolean;
  packageManager: string;
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.crew'
]);

const MAX_DEPTH = 3;
const MAX_FILES = 500;

/**
 * Analyze project structure to inject context into L3 execution briefs.
 */
export function analyzeProjectStructure(projectDir: string): StructureResult {
  const files: string[] = [];
  const directories: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH || files.length > MAX_FILES) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          directories.push(relative(projectDir, full));
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          files.push(relative(projectDir, full));
        }
      }
    } catch { /* permission errors, etc. */ }
  }

  walk(projectDir, 0);

  // Detect language
  const exts = files.map(f => extname(f).toLowerCase());
  const extCounts: Record<string, number> = {};
  for (const ext of exts) {
    if (ext) extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const topExt = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const langMap: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript/React', '.js': 'JavaScript', '.jsx': 'JavaScript/React',
    '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
    '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.swift': 'Swift', '.kt': 'Kotlin'
  };
  const language = langMap[topExt] || 'Unknown';

  // Detect framework
  let framework = 'None detected';
  const hasFile = (name: string) => files.some(f => f === name || f.endsWith('/' + name));
  if (hasFile('next.config.js') || hasFile('next.config.ts') || hasFile('next.config.mjs')) framework = 'Next.js';
  else if (hasFile('nuxt.config.ts') || hasFile('nuxt.config.js')) framework = 'Nuxt';
  else if (hasFile('angular.json')) framework = 'Angular';
  else if (hasFile('svelte.config.js')) framework = 'SvelteKit';
  else if (hasFile('vite.config.ts') || hasFile('vite.config.js')) framework = 'Vite';
  else if (hasFile('manage.py')) framework = 'Django';
  else if (hasFile('requirements.txt') && hasFile('app.py')) framework = 'Flask';
  else if (hasFile('Cargo.toml')) framework = 'Rust/Cargo';
  else if (hasFile('go.mod')) framework = 'Go modules';

  // Entry points
  const entryPatterns = ['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'main.py', 'app.py', 'main.go', 'main.rs'];
  const entryPoints = files.filter(f => entryPatterns.some(p => f === p || f.endsWith('/' + p))).slice(0, 5);

  // Tests
  const hasTests = files.some(f => f.includes('test') || f.includes('spec') || f.includes('__tests__'));

  // Config
  const hasConfig = files.some(f => f === 'tsconfig.json' || f === 'package.json' || f === 'pyproject.toml' || f === 'Cargo.toml');

  // Package manager
  let packageManager = 'unknown';
  if (hasFile('bun.lockb') || hasFile('bun.lock')) packageManager = 'bun';
  else if (hasFile('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (hasFile('yarn.lock')) packageManager = 'yarn';
  else if (hasFile('package-lock.json')) packageManager = 'npm';
  else if (hasFile('Pipfile.lock')) packageManager = 'pipenv';
  else if (hasFile('poetry.lock')) packageManager = 'poetry';

  return {
    language,
    framework,
    entryPoints,
    directories: directories.slice(0, 20),
    fileCount: files.length,
    hasTests,
    hasConfig,
    packageManager
  };
}

/**
 * Format structure analysis into a concise context string for L3 workers.
 */
export function formatStructureContext(result: StructureResult): string {
  const lines = [
    `Project: ${result.language} (${result.framework})`,
    `Files: ${result.fileCount} | Package manager: ${result.packageManager}`,
    `Tests: ${result.hasTests ? 'yes' : 'no'} | Config: ${result.hasConfig ? 'yes' : 'no'}`
  ];
  if (result.entryPoints.length > 0) {
    lines.push(`Entry points: ${result.entryPoints.join(', ')}`);
  }
  if (result.directories.length > 0) {
    lines.push(`Key dirs: ${result.directories.slice(0, 10).join(', ')}`);
  }
  return lines.join('\n');
}
