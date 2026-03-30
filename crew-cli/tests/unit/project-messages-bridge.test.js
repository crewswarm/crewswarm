import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('project-messages-bridge', () => {
  it('should export saveCliToProjectMessages', async () => {
    const mod = await import('../../src/session/project-messages-bridge.ts');
    assert.equal(typeof mod.saveCliToProjectMessages, 'function');
  });

  it('should export loadCliProjectHistory', async () => {
    const mod = await import('../../src/session/project-messages-bridge.ts');
    assert.equal(typeof mod.loadCliProjectHistory, 'function');
  });

  it('saveCliToProjectMessages does not throw on null projectDir', async () => {
    const mod = await import('../../src/session/project-messages-bridge.ts');
    // Should silently return when projectDir is falsy
    assert.doesNotThrow(() => {
      mod.saveCliToProjectMessages(null, { input: 'test', output: '', route: '', agent: '' });
    });
  });
});
