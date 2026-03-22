#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');
const testsRoot = path.join(repoRoot, 'tests');
const entryFiles = [
  path.join(srcRoot, 'cli', 'index.ts'),
  path.join(srcRoot, 'index.ts')
];

const SRC_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const IMPORT_RE = /\b(?:import|export)\s+[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function toRel(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

async function walkFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(abs);
      out.push(...nested);
      continue;
    }
    if (!SRC_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(abs);
  }
  return out;
}

function extractSpecifiers(source) {
  const specs = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      specs.push(match[1]);
    }
  }
  return specs;
}

function resolveToSrcFile(fromFile, specifier) {
  const candidates = [];
  const withTsFallback = value => {
    candidates.push(value);
    if (value.endsWith('.js')) candidates.push(`${value.slice(0, -3)}.ts`);
    if (value.endsWith('.mjs')) candidates.push(`${value.slice(0, -4)}.ts`);
    if (value.endsWith('.cjs')) candidates.push(`${value.slice(0, -4)}.ts`);
  };

  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    withTsFallback(base);
    withTsFallback(`${base}.ts`);
    withTsFallback(`${base}.js`);
    withTsFallback(path.join(base, 'index.ts'));
    withTsFallback(path.join(base, 'index.js'));
  } else if (specifier.startsWith('src/')) {
    const base = path.join(repoRoot, specifier);
    withTsFallback(base);
    withTsFallback(`${base}.ts`);
    withTsFallback(`${base}.js`);
    withTsFallback(path.join(base, 'index.ts'));
    withTsFallback(path.join(base, 'index.js'));
  } else if (specifier.startsWith('../src/') || specifier.startsWith('./src/')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    withTsFallback(base);
    withTsFallback(`${base}.ts`);
    withTsFallback(`${base}.js`);
    withTsFallback(path.join(base, 'index.ts'));
    withTsFallback(path.join(base, 'index.js'));
  } else {
    return null;
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (!candidate.startsWith(srcRoot)) continue;
    return path.normalize(candidate);
  }
  return null;
}

async function buildSrcGraph(srcFiles) {
  const graph = new Map();
  for (const file of srcFiles) {
    const source = await readFile(file, 'utf8');
    const specs = extractSpecifiers(source);
    const edges = [];
    for (const spec of specs) {
      const resolved = resolveToSrcFile(file, spec);
      if (resolved) edges.push(resolved);
    }
    graph.set(file, edges);
  }
  return graph;
}

function reachableFromEntries(graph, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const deps = graph.get(file) || [];
    for (const dep of deps) queue.push(dep);
  }
  return seen;
}

async function filesReferencedByTests(testFiles, srcFilesSet) {
  const referenced = new Set();
  for (const testFile of testFiles) {
    const source = await readFile(testFile, 'utf8');
    const specs = extractSpecifiers(source);
    for (const spec of specs) {
      const resolved = resolveToSrcFile(testFile, spec);
      if (resolved && srcFilesSet.has(resolved)) referenced.add(resolved);
    }
  }
  return referenced;
}

async function main() {
  if (!existsSync(srcRoot)) {
    throw new Error('Missing src/ directory.');
  }
  const srcFiles = (await walkFiles(srcRoot)).sort();
  const testFiles = existsSync(testsRoot) ? (await walkFiles(testsRoot)).sort() : [];
  const srcFileSet = new Set(srcFiles);

  const graph = await buildSrcGraph(srcFiles);
  const reachable = reachableFromEntries(
    graph,
    entryFiles.filter(file => existsSync(file))
  );
  const testReferenced = await filesReferencedByTests(testFiles, srcFileSet);

  const covered = new Set([...reachable, ...testReferenced]);
  const uncovered = srcFiles.filter(file => !covered.has(file));

  console.log(`[inventory] src files: ${srcFiles.length}`);
  console.log(`[inventory] reachable from entrypoint: ${reachable.size}`);
  console.log(`[inventory] explicitly referenced in tests: ${testReferenced.size}`);
  console.log(`[inventory] covered by build-or-test graph: ${covered.size}`);

  if (uncovered.length > 0) {
    console.error('[inventory] uncovered source files detected:');
    for (const file of uncovered) {
      console.error(`- ${toRel(file)}`);
    }
    process.exit(1);
  }

  console.log('[inventory] PASS: every src file is covered by build graph and/or tests.');
}

main().catch(error => {
  console.error(`[inventory] FAIL: ${error.message}`);
  process.exit(1);
});
