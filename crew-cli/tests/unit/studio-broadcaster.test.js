import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StudioBroadcaster } from '../../src/studio/broadcaster.ts';

describe('StudioBroadcaster', () => {
  it('should be constructable with defaults', () => {
    const b = new StudioBroadcaster();
    assert.ok(b);
  });

  it('isConnected returns false initially', () => {
    const b = new StudioBroadcaster();
    assert.equal(b.isConnected(), false);
  });

  it('disconnect does not throw when not connected', () => {
    const b = new StudioBroadcaster();
    assert.doesNotThrow(() => b.disconnect());
  });

  it('broadcastFileChange silently skips when not connected', async () => {
    const b = new StudioBroadcaster();
    await assert.doesNotReject(() => b.broadcastFileChange('/tmp/test.txt'));
  });

  it('broadcastFileDeleted silently skips when not connected', async () => {
    const b = new StudioBroadcaster();
    await assert.doesNotReject(() => b.broadcastFileDeleted('/tmp/test.txt'));
  });
});
