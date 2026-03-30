import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualFS, createVirtualFS } from '../../src/tools/virtual-fs.ts';

describe('VirtualFS', () => {
  it('should export VirtualFS class', () => {
    assert.equal(typeof VirtualFS, 'function');
  });

  it('should export createVirtualFS factory', () => {
    assert.equal(typeof createVirtualFS, 'function');
  });

  it('createVirtualFS creates a VirtualFS instance', () => {
    const mockSandbox = {
      getState: () => ({ branches: {} }),
      getActiveBranch: () => 'main',
      getPendingPaths: () => [],
      addChange: async () => {}
    };
    const vfs = createVirtualFS(mockSandbox, '/tmp');
    assert.ok(vfs instanceof VirtualFS);
  });

  it('isStaged returns false for un-staged path', () => {
    const mockSandbox = {
      getState: () => ({ branches: { main: {} } }),
      getActiveBranch: () => 'main',
      getPendingPaths: () => []
    };
    const vfs = new VirtualFS(mockSandbox, '/tmp');
    assert.equal(vfs.isStaged('foo.ts'), false);
  });
});
