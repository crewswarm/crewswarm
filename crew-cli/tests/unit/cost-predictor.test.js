import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateCost, compareModelCosts, getCheapestAlternative } from '../../src/cost/predictor.ts';

describe('cost-predictor', () => {
  it('estimateTokens returns positive number', () => {
    const count = estimateTokens('Hello world, this is a test string.');
    assert.ok(count > 0);
  });

  it('estimateTokens returns 1 for empty string', () => {
    const count = estimateTokens('');
    assert.equal(count, 1);
  });

  it('estimateCost returns CostEstimate shape', () => {
    const est = estimateCost('Hello world');
    assert.equal(typeof est.model, 'string');
    assert.equal(typeof est.inputTokens, 'number');
    assert.equal(typeof est.totalUsd, 'number');
    assert.ok(est.totalUsd >= 0);
  });

  it('estimateCost defaults to gpt-4o-mini when no model specified', () => {
    const est = estimateCost('test');
    assert.equal(est.model, 'openai/gpt-4o-mini');
  });

  it('compareModelCosts returns sorted array', () => {
    const costs = compareModelCosts('test prompt');
    assert.ok(Array.isArray(costs));
    assert.ok(costs.length > 1);
    for (let i = 1; i < costs.length; i++) {
      assert.ok(costs[i].totalUsd >= costs[i - 1].totalUsd);
    }
  });

  it('getCheapestAlternative returns cheapest model', () => {
    const cheapest = getCheapestAlternative('test');
    assert.ok(cheapest.totalUsd > 0);
  });
});
