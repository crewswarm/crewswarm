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
    // reasoning is optional — validator should accept with or without it
    const result = validateRouterDecision({ decision, reasoning: 'clear rationale' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);

    const noReasoning = validateRouterDecision({ decision });
    assert.equal(noReasoning.ok, true, `decision "${decision}" should pass without reasoning`);
  }
});

test('validateRouterDecision rejects invalid payloads', () => {
  assert.deepEqual(validateRouterDecision(null), { ok: false, errors: ['must be object'] });

  const invalid = validateRouterDecision({ decision: 'UNKNOWN' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' | '), /invalid decision/);
});

test('validateWorkGraph accepts well-formed graph', () => {
  const payload = {
    units: [
      {
        id: 'u1',
        description: 'Do step one',
        requiredPersona: 'executor-code',
        dependencies: [],
        requiredCapabilities: ['code-generation', 'file-write'],
        sourceRefs: ['ROADMAP.md#step-1'],
        allowedPaths: ['src/example.ts'],
        verification: ['Confirm src/example.ts changed'],
        escalationHints: ['Escalate if another file must be edited'],
        maxFilesTouched: 1,
      },
    ],
    requiredPersonas: ['executor-code'],
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
  assert.match(merged, /unit\.sourceRefs missing/);
  assert.match(merged, /unit\.allowedPaths must be array/);
  assert.match(merged, /unit\.verification missing/);
  assert.match(merged, /unit\.escalationHints missing/);
  assert.match(merged, /unit\.maxFilesTouched invalid/);
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
