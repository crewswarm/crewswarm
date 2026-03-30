import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSiblingRepos, getRepoSummary } from '../../src/multirepo/index.ts';

describe('multirepo', () => {
  it('findSiblingRepos returns an array', async () => {
    const repos = await findSiblingRepos(process.cwd());
    assert.ok(Array.isArray(repos));
  });

  it('getRepoSummary returns RepoSummary shape', async () => {
    const summary = await getRepoSummary(process.cwd());
    assert.equal(typeof summary.name, 'string');
    assert.equal(typeof summary.path, 'string');
    assert.equal(typeof summary.branch, 'string');
    assert.equal(typeof summary.recentCommit, 'string');
  });

  it('findSiblingRepos does not include self', async () => {
    const repos = await findSiblingRepos(process.cwd());
    const cwd = process.cwd();
    assert.ok(!repos.includes(cwd));
  });
});
