import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsonCandidate,
  sanitizeBrokenJson,
  parseJsonObject,
  parseJsonObjectWithRepair
} from '../../src/utils/structured-json.ts';

test('extractJsonCandidate reads fenced JSON blocks', () => {
  const raw = 'some intro\n```json\n{"a":1,"b":true}\n```\noutro';
  assert.equal(extractJsonCandidate(raw), '{"a":1,"b":true}');
});

test('extractJsonCandidate reads first/last object braces in free text', () => {
  const raw = 'prefix text {"ok":true,"n":3} suffix text';
  assert.equal(extractJsonCandidate(raw), '{"ok":true,"n":3}');
});

test('extractJsonCandidate throws if object braces are missing', () => {
  assert.throws(() => extractJsonCandidate('no object here'), /Expected JSON object/);
});

test('sanitizeBrokenJson removes trailing commas and escapes control chars in strings', () => {
  const broken = '{"a":"line1\nline2","arr":[1,2,],}';
  const sanitized = sanitizeBrokenJson(broken);
  const parsed = JSON.parse(sanitized);
  assert.equal(parsed.a, 'line1\nline2');
  assert.deepEqual(parsed.arr, [1, 2]);
});

test('sanitizeBrokenJson closes unbalanced braces and brackets', () => {
  const broken = '{"a":[1,2';
  const sanitized = sanitizeBrokenJson(broken);
  assert.match(sanitized, /\}\]$/);
  assert.equal((sanitized.match(/\{/g) || []).length, (sanitized.match(/\}/g) || []).length);
  assert.equal((sanitized.match(/\[/g) || []).length, (sanitized.match(/\]/g) || []).length);
});

test('parseJsonObject falls back to sanitized parse for broken JSON', () => {
  const parsed = parseJsonObject('{"name":"x","vals":[1,2,],}');
  assert.equal(parsed.name, 'x');
  assert.deepEqual(parsed.vals, [1, 2]);
});

test('parseJsonObjectWithRepair succeeds immediately when JSON is valid', async () => {
  const attempts = [];
  const parsed = await parseJsonObjectWithRepair('{"decision":"CODE","ok":true}', {
    label: 'router decision',
    validate: (v) => ({ ok: Boolean(v?.decision), errors: ['decision missing'] }),
    onAttempt: async (meta) => {
      attempts.push(meta);
    }
  });

  assert.equal(parsed.decision, 'CODE');
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0], {
    label: 'router decision',
    attempt: 1,
    success: true,
    repaired: false,
  });
});

test('parseJsonObjectWithRepair calls repair callback after failed attempt', async () => {
  const attempts = [];
  let repairCalled = 0;

  const parsed = await parseJsonObjectWithRepair('not json', {
    label: 'unit-json',
    maxAttempts: 2,
    onAttempt: async (meta) => attempts.push(meta),
    repair: async (prompt) => {
      repairCalled += 1;
      assert.match(prompt, /Convert the following content to STRICT valid JSON\./);
      return '{"answer":42}';
    }
  });

  assert.equal(repairCalled, 1);
  assert.equal(parsed.answer, 42);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].success, false);
  assert.equal(attempts[1].success, true);
  assert.equal(attempts[1].repaired, true);
});

test('parseJsonObjectWithRepair throws after max attempts and reports label', async () => {
  await assert.rejects(
    parseJsonObjectWithRepair('{"payload":true}', {
      label: 'schema payload',
      maxAttempts: 1,
      validate: () => ({ ok: false, errors: ['invalid schema'] })
    }),
    /schema payload parse failed after 1 attempt\(s\): invalid schema/
  );
});

test('parseJsonObjectWithRepair uses default attempts when maxAttempts is falsy', async () => {
  await assert.rejects(
    parseJsonObjectWithRepair('bad json', {
      label: 'clamp',
      maxAttempts: 0,
    }),
    /clamp parse failed after 2 attempt\(s\)/
  );
});
