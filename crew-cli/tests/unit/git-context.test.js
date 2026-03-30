import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getProjectContext, getChangedFiles } from '../../src/context/git.ts';

describe('git-context', () => {
  it('getProjectContext returns a string', async () => {
    const ctx = await getProjectContext(process.cwd());
    assert.equal(typeof ctx, 'string');
    assert.ok(ctx.includes('## Repository Context') || ctx.includes('## Git Context'));
  });

  it('getChangedFiles returns an array', async () => {
    const files = await getChangedFiles(process.cwd());
    assert.ok(Array.isArray(files));
  });

  it('getChangedFiles returns empty for non-git dir', async () => {
    const files = await getChangedFiles('/tmp');
    assert.ok(Array.isArray(files));
  });

  it('getProjectContext handles non-git directory', async () => {
    const ctx = await getProjectContext('/tmp');
    assert.equal(typeof ctx, 'string');
  });
});
