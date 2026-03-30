import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPtyCommand } from '../../src/pty/index.ts';

describe('pty', () => {
  it('should export runPtyCommand', () => {
    assert.equal(typeof runPtyCommand, 'function');
  });

  it('throws on empty command', async () => {
    await assert.rejects(() => runPtyCommand(''), /PTY command is required/);
  });

  it('throws on whitespace-only command', async () => {
    await assert.rejects(() => runPtyCommand('   '), /PTY command is required/);
  });
});
