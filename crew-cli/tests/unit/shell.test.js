import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runShellCopilot } from '../../src/shell/index.ts';

describe('shell', () => {
  it('should export runShellCopilot as a function', () => {
    assert.equal(typeof runShellCopilot, 'function');
  });

  it('runShellCopilot expects 2-3 arguments', () => {
    // request, router, options
    assert.ok(runShellCopilot.length >= 2);
  });
});
