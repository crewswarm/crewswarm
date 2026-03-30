import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCheckCommand } from '../../src/ci/index.ts';

describe('ci - runCheckCommand', () => {
  it('successful command returns success: true', async () => {
    const result = await runCheckCommand('echo hello');
    assert.equal(result.success, true);
    assert.equal(result.command, 'echo hello');
    assert.ok(result.stdout.includes('hello'));
  });

  it('failing command returns success: false', async () => {
    const result = await runCheckCommand('exit 1');
    assert.equal(result.success, false);
  });

  it('captures stderr on failure', async () => {
    const result = await runCheckCommand('echo errout >&2 && exit 1');
    assert.equal(result.success, false);
    assert.ok(result.stderr.includes('errout'));
  });

  it('result always has command field', async () => {
    const result = await runCheckCommand('true');
    assert.equal(result.command, 'true');
  });
});
