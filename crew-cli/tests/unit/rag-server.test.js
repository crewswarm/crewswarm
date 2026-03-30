import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// startRagServer is the only export; it starts an HTTP server which requires
// express + codebase-rag deps.  We smoke-test the import and confirm the
// function signature without actually binding a port.

describe('rag-server', () => {
  it('should export startRagServer as a function', async () => {
    const mod = await import('../../src/api/rag-server.ts');
    assert.equal(typeof mod.startRagServer, 'function');
  });

  it('startRagServer should accept an options object', async () => {
    const mod = await import('../../src/api/rag-server.ts');
    // The function accepts RagServerOptions with port, host, verbose
    assert.equal(mod.startRagServer.length, 0); // all optional, so length 0
  });
});
