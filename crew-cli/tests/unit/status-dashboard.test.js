import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemStatus, renderStatusDashboard } from '../../src/status/dashboard.ts';

describe('status-dashboard', () => {
  it('getSystemStatus returns StatusInfo shape', async () => {
    const status = await getSystemStatus();
    assert.equal(typeof status.online, 'boolean');
    assert.ok(Array.isArray(status.models));
    assert.equal(typeof status.gatewayUrl, 'string');
  });

  it('renderStatusDashboard returns string', async () => {
    const status = await getSystemStatus();
    const output = renderStatusDashboard(status);
    assert.equal(typeof output, 'string');
    assert.ok(output.includes('CREW-CLI'));
  });

  it('renderStatusDashboard accepts options', async () => {
    const status = await getSystemStatus();
    const output = renderStatusDashboard(status, { interfaceMode: 'standalone' });
    assert.equal(typeof output, 'string');
  });
});
