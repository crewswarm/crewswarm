import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DockerSandbox } from '../../src/tools/docker-sandbox.ts';

describe('DockerSandbox', () => {
  it('should be constructable', () => {
    const ds = new DockerSandbox();
    assert.ok(ds);
  });

  it('isDockerAvailable returns a boolean', async () => {
    const ds = new DockerSandbox();
    const available = await ds.isDockerAvailable();
    assert.equal(typeof available, 'boolean');
  });

  it('ensureImage returns a boolean', async () => {
    const ds = new DockerSandbox();
    // This may return false if docker is not installed -- that's fine
    const result = await ds.ensureImage('nonexistent-image-xyz:latest');
    assert.equal(typeof result, 'boolean');
  });
});
