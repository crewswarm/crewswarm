import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getExecutionPolicy, isRetryableError, isRiskBlocked, withRetries } from '../../src/runtime/execution-policy.ts';

describe('execution-policy', () => {
  it('getExecutionPolicy returns defaults', () => {
    const policy = getExecutionPolicy();
    assert.equal(policy.retryAttempts, 2);
    assert.equal(policy.riskThreshold, 'high');
    assert.equal(typeof policy.strictPreflight, 'boolean');
    assert.equal(typeof policy.diffFirst, 'boolean');
  });

  it('getExecutionPolicy respects overrides', () => {
    const policy = getExecutionPolicy({ retryAttempts: 4, riskThreshold: 'low' });
    assert.equal(policy.retryAttempts, 4);
    assert.equal(policy.riskThreshold, 'low');
  });

  it('isRetryableError detects rate limit', () => {
    assert.equal(isRetryableError(new Error('rate limit exceeded')), true);
    assert.equal(isRetryableError(new Error('some other error')), false);
  });

  it('isRetryableError detects timeout', () => {
    assert.equal(isRetryableError(new Error('request timeout')), true);
  });

  it('isRiskBlocked blocks when risk >= threshold', () => {
    assert.equal(isRiskBlocked('high', 'high'), true);
    assert.equal(isRiskBlocked('low', 'high'), false);
    assert.equal(isRiskBlocked('medium', 'medium'), true);
  });

  it('isRiskBlocked respects force flag', () => {
    assert.equal(isRiskBlocked('high', 'low', true), false);
  });

  it('withRetries succeeds on first try', async () => {
    const policy = getExecutionPolicy({ retryAttempts: 3 });
    const result = await withRetries(() => Promise.resolve(42), policy);
    assert.equal(result, 42);
  });
});
