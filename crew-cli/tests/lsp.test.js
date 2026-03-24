import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCompletions, typeCheckProject } from '../src/lsp/index.ts';

test('typeCheckProject returns diagnostics for invalid assignment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-lsp-check-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*']
  }, null, 2), 'utf8');
  await writeFile(join(dir, 'src', 'bad.ts'), 'const x: string = 123;\n', 'utf8');

  const diagnostics = await typeCheckProject(dir);
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.some(d => d.file.endsWith('bad.ts')));
});

test('getCompletions returns property suggestions at cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-lsp-complete-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*']
  }, null, 2), 'utf8');
  await writeFile(join(dir, 'src', 'main.ts'), 'const obj = { alpha: 1, beta: 2 };\nobj.\n', 'utf8');

  const completions = await getCompletions(dir, 'src/main.ts', 2, 5, 100);
  assert.ok(completions.some(item => item.name === 'alpha'));
  assert.ok(completions.some(item => item.name === 'beta'));
});
