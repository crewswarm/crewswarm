import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scorePatchRisk } from '../../src/risk/score.ts';

describe('risk-score', () => {
  it('minimal input returns low risk', () => {
    const result = scorePatchRisk({ changedFiles: 1, validationPassed: true });
    assert.equal(result.riskLevel, 'low');
    assert.equal(result.level, 'low');
    assert.ok(result.riskScore >= 0 && result.riskScore <= 100);
  });

  it('large change set raises risk', () => {
    const result = scorePatchRisk({ changedFiles: 15 });
    assert.ok(result.reasons.includes('large-change-set'));
  });

  it('high blast radius raises risk', () => {
    const result = scorePatchRisk({ risk: 'high', changedFiles: 20 });
    assert.ok(result.reasons.includes('high-blast-radius'));
  });

  it('confidence + risk sum to ~1', () => {
    const result = scorePatchRisk({ changedFiles: 5 });
    const sum = (result.riskScore / 100) + result.confidenceScore;
    assert.ok(Math.abs(sum - 1) < 0.01);
  });

  it('validation-passed reduces risk', () => {
    const withVal = scorePatchRisk({ changedFiles: 3, validationPassed: true });
    const without = scorePatchRisk({ changedFiles: 3 });
    assert.ok(withVal.riskScore <= without.riskScore);
  });
});
