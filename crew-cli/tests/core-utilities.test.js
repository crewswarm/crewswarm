import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { factorial } from '../src/utils/math.ts';
import { extractJsonCandidate, parseJsonObject, parseJsonObjectWithRepair, sanitizeBrokenJson } from '../src/utils/structured-json.ts';
import { validatePolicyValidation, validateRouterDecision, validateWorkGraph } from '../src/utils/json-schemas.ts';
import { Logger as TsLogger } from '../src/utils/logger.ts';
import { Logger as JsLogger } from '../src/utils/logger.js';

describe('math utility', () => {
  test('factorial computes expected values', () => {
    assert.equal(factorial(0), 1);
    assert.equal(factorial(6), 720);
  });

  test('factorial rejects invalid input', () => {
    assert.throws(() => factorial(-1), /negative numbers/);
    assert.throws(() => factorial(2.5), /only supports integers/);
  });
});

describe('structured-json utility', () => {
  test('extractJsonCandidate pulls JSON from fenced and mixed text', () => {
    assert.equal(extractJsonCandidate('```json\n{"ok":true}\n```'), '{"ok":true}');
    assert.equal(extractJsonCandidate('before {"n":3} after'), '{"n":3}');
  });

  test('sanitizeBrokenJson repairs trailing commas and unbalanced braces', () => {
    const repaired = sanitizeBrokenJson('{"a":"line1\nline2","arr":[1,2,],}');
    assert.deepEqual(JSON.parse(repaired), { a: 'line1\nline2', arr: [1, 2] });
  });

  test('parseJsonObjectWithRepair uses repair callback on parse failure', async () => {
    const parsed = await parseJsonObjectWithRepair('not-json', {
      label: 'unit',
      repair: async () => '{"mode":"CHAT"}'
    });
    assert.equal(parsed.mode, 'CHAT');
  });

  test('parseJsonObjectWithRepair throws with label after max attempts', async () => {
    await assert.rejects(
      parseJsonObjectWithRepair('still-not-json', { label: 'parser', maxAttempts: 1 }),
      /parser parse failed/
    );
  });

  test('parseJsonObject falls back to sanitized parsing', () => {
    const parsed = parseJsonObject('{"list":[1,2,],}');
    assert.deepEqual(parsed.list, [1, 2]);
  });
});

describe('json-schemas utility', () => {
  test('validateRouterDecision accepts known decision types', () => {
    const result = validateRouterDecision({ decision: 'DISPATCH', reasoning: 'use specialist agent' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  test('validateRouterDecision rejects missing reasoning', () => {
    const result = validateRouterDecision({ decision: 'CHAT', reasoning: '' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /missing reasoning/);
  });

  test('validateWorkGraph checks top-level and unit fields', () => {
    const ok = validateWorkGraph({
      units: [{
        id: 'u1',
        description: 'Implement the authentication handler with JWT validation',
        requiredPersona: 'crew-coder',
        dependencies: [],
        requiredCapabilities: [],
        sourceRefs: ['PDD.md#1'],
        allowedPaths: ['src/'],
        verification: ['unit tests pass'],
        escalationHints: ['if auth library missing'],
        maxFilesTouched: 5
      }],
      requiredPersonas: ['crew-coder'],
      totalComplexity: 1,
      estimatedCost: 0.1
    });
    assert.equal(ok.ok, true);

    const bad = validateWorkGraph({ units: [null], requiredPersonas: 'bad', totalComplexity: 'x', estimatedCost: 'y' });
    assert.equal(bad.ok, false);
  });

  test('validatePolicyValidation validates expected types', () => {
    const ok = validatePolicyValidation({
      approved: true,
      riskLevel: 'medium',
      concerns: [],
      recommendations: ['monitor'],
      estimatedCost: 1.2
    });
    assert.equal(ok.ok, true);

    const bad = validatePolicyValidation({
      approved: 'yes',
      riskLevel: 'urgent',
      concerns: 'none',
      recommendations: {},
      estimatedCost: 'high'
    });
    assert.equal(bad.ok, false);
  });
});

describe('logger utilities', () => {
  test('TS logger highlights diff metadata and hunks', () => {
    const logger = new TsLogger({ prefix: '[Test]' });
    const highlighted = logger.highlightDiff(['diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'));
    assert.match(highlighted, /diff --git/);
    assert.match(highlighted, /\+new/);
    assert.match(highlighted, /-old/);
  });

  test('JS logger debug only emits when level=debug', () => {
    const originalLog = console.log;
    const seen = [];
    console.log = (...args) => seen.push(args.join(' '));

    try {
      new JsLogger({ level: 'info' }).debug('hidden');
      new JsLogger({ level: 'debug' }).debug('shown');
    } finally {
      console.log = originalLog;
    }

    assert.equal(seen.length, 1);
    assert.match(seen[0], /\[DEBUG\]/);
  });
});
