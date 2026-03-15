import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRouterDecision,
  validateWorkGraph,
  validatePolicyValidation,
} from '../../src/utils/json-schemas.ts';

test('validateRouterDecision accepts all supported decision values', () => {
  const decisions = ['direct-answer', 'execute-local', 'execute-parallel', 'CHAT', 'CODE', 'DISPATCH'];

  for (const decision of decisions) {
    const result = validateRouterDecision({ decision, reasoning: 'clear rationale' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  }
});

test('validateRouterDecision rejects invalid payloads', () => {
  assert.deepEqual(validateRouterDecision(null), { ok: false, errors: ['must be object'] });

  const invalid = validateRouterDecision({ decision: 'UNKNOWN', reasoning: ' ' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' | '), /invalid decision/);
  assert.match(invalid.errors.join(' | '), /missing reasoning/);
});

test('validateWorkGraph accepts well-formed graph', () => {
  const payload = {
    units: [
      {
        id: 'u1',
        description: 'Do step one',
        requiredPersona: 'crew-coder',
        dependencies: [],
        requiredCapabilities: ['write_file'],
      },
    ],
    requiredPersonas: ['crew-coder'],
    totalComplexity: 3,
    estimatedCost: 0.42,
  };

  const result = validateWorkGraph(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateWorkGraph reports top-level and unit-level errors', () => {
  const result = validateWorkGraph({
    units: [null, { id: '', description: '', requiredPersona: '', dependencies: 'bad', requiredCapabilities: 'bad' }],
    requiredPersonas: 'crew-coder',
    totalComplexity: '3',
    estimatedCost: '1.0',
  });

  assert.equal(result.ok, false);
  const merged = result.errors.join(' | ');
  assert.match(merged, /requiredPersonas must be array/);
  assert.match(merged, /totalComplexity must be number/);
  assert.match(merged, /estimatedCost must be number/);
  assert.match(merged, /unit must be object/);
  assert.match(merged, /unit\.id missing/);
  assert.match(merged, /unit\.description missing/);
  assert.match(merged, /unit\.requiredPersona missing/);
  assert.match(merged, /unit\.dependencies must be array/);
  assert.match(merged, /unit\.requiredCapabilities must be array/);
});

test('validatePolicyValidation accepts valid policy validation payload', () => {
  const result = validatePolicyValidation({
    approved: true,
    riskLevel: 'low',
    concerns: [],
    recommendations: ['ship it'],
    estimatedCost: 2,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validatePolicyValidation rejects malformed payload', () => {
  const result = validatePolicyValidation({
    approved: 'yes',
    riskLevel: 'unknown',
    concerns: 'none',
    recommendations: {},
    estimatedCost: '5',
  });

  assert.equal(result.ok, false);
  const merged = result.errors.join(' | ');
  assert.match(merged, /approved must be boolean/);
  assert.match(merged, /invalid riskLevel/);
  assert.match(merged, /concerns must be array/);
  assert.match(merged, /recommendations must be array/);
  assert.match(merged, /estimatedCost must be number/);
});
