#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function stdout(result) {
  return String(result?.stdout || '').trim();
}

function tryMergeBase(baseRef) {
  const res = run('git', ['merge-base', 'HEAD', baseRef]);
  if (res.status !== 0) return '';
  return stdout(res);
}

function resolveBase() {
  const envBase = String(process.env.CREW_TYPECHECK_BASE || '').trim();
  if (envBase) {
    const mb = tryMergeBase(envBase);
    if (mb) return mb;
  }

  const ghBase = String(process.env.GITHUB_BASE_REF || '').trim();
  if (ghBase) {
    const mb = tryMergeBase(`origin/${ghBase}`);
    if (mb) return mb;
  }

  for (const candidate of ['origin/main', 'origin/master']) {
    const mb = tryMergeBase(candidate);
    if (mb) return mb;
  }

  const prev = run('git', ['rev-parse', 'HEAD~1']);
  if (prev.status === 0) return stdout(prev);
  return '';
}

function listChangedFiles(baseSha) {
  const range = baseSha ? `${baseSha}...HEAD` : 'HEAD';
  const res = run('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', range]);
  if (res.status !== 0) return [];
  return stdout(res).split('\n').map(s => s.trim()).filter(Boolean);
}

function main() {
  const baseSha = resolveBase();
  const changed = listChangedFiles(baseSha);
  const touchedSrcTs = changed.filter((p) => /^src\/.+\.(ts|tsx)$/.test(p));

  if (touchedSrcTs.length === 0) {
    console.log('typecheck:touched: no changed files under src/**/*.ts, skipping.');
    process.exit(0);
  }

  console.log(`typecheck:touched: checking ${touchedSrcTs.length} file(s).`);
  const tsc = run('npx', ['tsc', '--noEmit', '--pretty', 'false', ...touchedSrcTs], {
    stdio: 'inherit'
  });
  process.exit(Number(tsc.status || 0));
}

main();
