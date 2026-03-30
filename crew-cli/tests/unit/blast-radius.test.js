import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSeverityAtLeast } from '../../src/blast-radius/index.ts';

describe('blast-radius', () => {
  it('isSeverityAtLeast: high >= high', () => {
    assert.equal(isSeverityAtLeast('high', 'high'), true);
  });

  it('isSeverityAtLeast: low >= high is false', () => {
    assert.equal(isSeverityAtLeast('low', 'high'), false);
  });

  it('isSeverityAtLeast: medium >= low is true', () => {
    assert.equal(isSeverityAtLeast('medium', 'low'), true);
  });

  it('isSeverityAtLeast: low >= low is true', () => {
    assert.equal(isSeverityAtLeast('low', 'low'), true);
  });

  it('isSeverityAtLeast: high >= low is true', () => {
    assert.equal(isSeverityAtLeast('high', 'low'), true);
  });
});
