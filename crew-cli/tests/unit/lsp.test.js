import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('lsp', () => {
  it('should export typeCheckProject', async () => {
    const mod = await import('../../src/lsp/index.ts');
    assert.equal(typeof mod.typeCheckProject, 'function');
  });

  it('should export getCompletions', async () => {
    const mod = await import('../../src/lsp/index.ts');
    assert.equal(typeof mod.getCompletions, 'function');
  });

  it('should export getDefinitions', async () => {
    const mod = await import('../../src/lsp/index.ts');
    assert.equal(typeof mod.getDefinitions, 'function');
  });

  it('should export getReferences', async () => {
    const mod = await import('../../src/lsp/index.ts');
    assert.equal(typeof mod.getReferences, 'function');
  });

  it('should export getDocumentSymbols', async () => {
    const mod = await import('../../src/lsp/index.ts');
    assert.equal(typeof mod.getDocumentSymbols, 'function');
  });
});
