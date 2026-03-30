import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectFileForTodos } from '../../src/watch/index.ts';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('watch', () => {
  it('inspectFileForTodos detects TODO in file', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'watch-'));
    const file = join(tmp, 'test.ts');
    await writeFile(file, '// TODO: fix this\nconst x = 1;\n');
    try {
      const event = await inspectFileForTodos(file);
      assert.equal(event.type, 'todo_detected');
      assert.equal(event.todoCount, 1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('inspectFileForTodos returns file_changed for clean file', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'watch-'));
    const file = join(tmp, 'clean.ts');
    await writeFile(file, 'const x = 1;\n');
    try {
      const event = await inspectFileForTodos(file);
      assert.equal(event.type, 'file_changed');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('inspectFileForTodos handles missing file', async () => {
    const event = await inspectFileForTodos('/tmp/nonexistent-file-xyz.ts');
    assert.equal(event.type, 'file_changed');
  });
});
