import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { healthCheck } from '../../src/lib/health-check.ts';

describe('health-check', () => {
  it('should export healthCheck as a function', () => {
    assert.equal(typeof healthCheck, 'function');
  });

  it('healthCheck returns HealthStatus shape', async () => {
    const status = await healthCheck();
    assert.equal(typeof status.agents, 'object');
    assert.equal(typeof status.services, 'object');
    assert.equal(typeof status.timestamp, 'number');
  });

  it('services have expected keys', async () => {
    const status = await healthCheck();
    assert.ok('rtBus' in status.services);
    assert.ok('crewLead' in status.services);
  });
});
