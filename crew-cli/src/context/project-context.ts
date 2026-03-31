/**
 * Immutable ProjectContext — frozen snapshot of the project at session start.
 *
 * Built once, injected into every system prompt (L1 router, L2 planner, L3 workers).
 * Prevents workers from creating wrong-tech-stack code (e.g., Node.js modules
 * for browser projects, TypeScript for vanilla JS projects).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;     // relative to project root
  type: 'file' | 'dir';
  size: number;
  ext: string;
}

export type TechStack =
  | 'static-html'
  | 'node-js'
  | 'node-ts'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  | 'php'
  | 'unknown';

export interface ProjectConfig {
  name?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  tsconfig?: boolean;
  eslint?: boolean;
  prettier?: boolean;
  gitignorePatterns?: string[];
}

export interface ProjectContext {
  readonly root: string;
  readonly techStack: TechStack;
  readonly fileTree: ReadonlyArray<FileEntry>;
  readonly config: Readonly<ProjectConfig>;
  readonly summary: string;        // pre-formatted context string for injection
  readonly builtAt: number;        // Date.now() — never changes
}

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.crew', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.vscode', 'coverage', '.turbo',
  '.cache', '.parcel-cache', '.output', '.nuxt', '.svelte-kit'
]);

const IGNORE_EXTS = new Set([
  '.map', '.lock', '.log', '.DS_Store', '.ico', '.woff', '.woff2', '.eot',
  '.ttf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.mp3',
  '.wav', '.pdf', '.zip', '.tar', '.gz'
]);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildProjectContext(projectRoot: string): Promise<ProjectContext> {
  const fileTree: FileEntry[] = [];

  // Walk directory (max 2 levels deep, max 500 files to stay fast)
  await walkDir(projectRoot, projectRoot, fileTree, 0, 3, 500);

  const config = await detectConfig(projectRoot);
  const techStack = detectTechStack(fileTree, config);
  const summary = formatContextSummary(projectRoot, techStack, fileTree, config);

  const ctx: ProjectContext = Object.freeze({
    root: projectRoot,
    techStack,
    fileTree: Object.freeze(fileTree),
    config: Object.freeze(config),
    summary,
    builtAt: Date.now()
  });

  return ctx;
}

async function walkDir(
  base: string,
  dir: string,
  entries: FileEntry[],
  depth: number,
  maxDepth: number,
  maxFiles: number
): Promise<void> {
  if (depth > maxDepth || entries.length >= maxFiles) return;

  let dirEntries: string[];
  try {
    dirEntries = await readdir(dir);
  } catch {
    return;
  }

  for (const name of dirEntries) {
    if (entries.length >= maxFiles) break;
    if (name.startsWith('.') && name !== '.gitignore') continue;
    if (IGNORE_DIRS.has(name)) continue;

    const fullPath = join(dir, name);
    try {
      const s = await stat(fullPath);
      const relPath = relative(base, fullPath);
      const ext = extname(name);

      if (s.isDirectory()) {
        entries.push({ path: relPath, type: 'dir', size: 0, ext: '' });
        await walkDir(base, fullPath, entries, depth + 1, maxDepth, maxFiles);
      } else if (s.isFile() && !IGNORE_EXTS.has(ext.toLowerCase())) {
        entries.push({ path: relPath, type: 'file', size: s.size, ext });
      }
    } catch {
      // skip inaccessible
    }
  }
}

async function detectConfig(root: string): Promise<ProjectConfig> {
  const config: ProjectConfig = {};

  // package.json
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    config.name = pkg.name;
    config.dependencies = pkg.dependencies;
    config.devDependencies = pkg.devDependencies;
    config.scripts = pkg.scripts;
    if (pkg.packageManager?.startsWith('yarn')) config.packageManager = 'yarn';
    else if (pkg.packageManager?.startsWith('pnpm')) config.packageManager = 'pnpm';
    else if (pkg.packageManager?.startsWith('bun')) config.packageManager = 'bun';
    else config.packageManager = 'npm';
  } catch {
    // no package.json
  }

  // tsconfig
  try {
    await stat(join(root, 'tsconfig.json'));
    config.tsconfig = true;
  } catch {
    config.tsconfig = false;
  }

  // .gitignore
  try {
    const gi = await readFile(join(root, '.gitignore'), 'utf8');
    config.gitignorePatterns = gi.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 20);
  } catch {
    // no .gitignore
  }

  return config;
}

function detectTechStack(files: FileEntry[], config: ProjectConfig): TechStack {
  const exts = new Set(files.filter(f => f.type === 'file').map(f => f.ext.toLowerCase()));
  const hasTS = exts.has('.ts') || exts.has('.tsx') || config.tsconfig;
  const hasJS = exts.has('.js') || exts.has('.jsx') || exts.has('.mjs');
  const hasPy = exts.has('.py');
  const hasGo = exts.has('.go');
  const hasRust = exts.has('.rs');
  const hasJava = exts.has('.java');
  const hasRuby = exts.has('.rb');
  const hasPHP = exts.has('.php');
  const hasHTML = exts.has('.html') || exts.has('.htm');

  if (hasTS && config.dependencies) return 'node-ts';
  if (hasJS && config.dependencies) return 'node-js';
  if (hasPy) return 'python';
  if (hasGo) return 'go';
  if (hasRust) return 'rust';
  if (hasJava) return 'java';
  if (hasRuby) return 'ruby';
  if (hasPHP) return 'php';
  if (hasHTML && !config.dependencies) return 'static-html';
  if (hasJS && !config.dependencies) return 'static-html'; // vanilla JS without package.json
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Format for injection
// ---------------------------------------------------------------------------

function formatContextSummary(
  root: string,
  techStack: TechStack,
  files: FileEntry[],
  config: ProjectConfig
): string {
  const lines: string[] = [];
  lines.push(`## Project Context (auto-detected, frozen at session start)`);
  lines.push(`- **Root**: ${root}`);
  lines.push(`- **Tech stack**: ${techStack}`);
  lines.push(`- **Files scanned**: ${files.length}`);

  if (config.name) lines.push(`- **Package**: ${config.name}`);
  if (config.packageManager) lines.push(`- **Package manager**: ${config.packageManager}`);
  if (config.tsconfig) lines.push(`- **TypeScript**: yes (tsconfig.json present)`);

  // Key dependencies
  const allDeps = { ...config.dependencies, ...config.devDependencies };
  const importantDeps = Object.keys(allDeps).filter(d =>
    ['react', 'vue', 'svelte', 'angular', 'next', 'nuxt', 'express', 'fastify', 'hono',
     'tailwindcss', 'prisma', 'drizzle', 'mongoose', 'sequelize', 'jest', 'vitest', 'mocha',
     'webpack', 'vite', 'esbuild', 'rollup', 'turbo'].includes(d)
  );
  if (importantDeps.length > 0) {
    lines.push(`- **Key deps**: ${importantDeps.join(', ')}`);
  }

  // Tech stack constraints
  const constraints: string[] = [];
  if (techStack === 'static-html') {
    constraints.push('This is a static HTML/CSS/JS project. Do NOT use require(), import/export, or Node.js APIs.');
    constraints.push('Do NOT create package.json or node_modules. Keep all JS in <script> tags or vanilla .js files.');
  }
  if (techStack === 'node-ts') {
    constraints.push('This is a TypeScript project. Use .ts extensions, type annotations, and import/export syntax.');
  }
  if (techStack === 'node-js') {
    constraints.push('This is a Node.js JavaScript project. Check existing files for module style (ESM vs CJS) before writing new code.');
  }

  if (constraints.length > 0) {
    lines.push(`\n### Constraints`);
    for (const c of constraints) lines.push(`- ${c}`);
  }

  // Directory structure (top-level only)
  const dirs = files.filter(f => f.type === 'dir').map(f => f.path).sort();
  if (dirs.length > 0) {
    lines.push(`\n### Directory Structure`);
    lines.push('```');
    for (const d of dirs.slice(0, 30)) lines.push(`  ${d}/`);
    lines.push('```');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Singleton cache
// ---------------------------------------------------------------------------

let _cachedContext: ProjectContext | null = null;

export async function getProjectContext(projectRoot: string): Promise<ProjectContext> {
  if (_cachedContext && _cachedContext.root === projectRoot) return _cachedContext;
  _cachedContext = await buildProjectContext(projectRoot);
  return _cachedContext;
}

export function clearProjectContextCache(): void {
  _cachedContext = null;
}
