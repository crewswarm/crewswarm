import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factorial } from '../../src/utils/math.ts';

test('factorial returns expected values for common inputs', () => {
  assert.equal(factorial(0), 1);
  assert.equal(factorial(1), 1);
  assert.equal(factorial(5), 120);
  assert.equal(factorial(10), 3628800);
});

test('factorial supports larger integer inputs', () => {
  assert.equal(factorial(12), 479001600);
});

test('factorial rejects non-integer values', () => {
  assert.throws(() => factorial(1.5), /only supports integers/);
  assert.throws(() => factorial(Number.NaN), /only supports integers/);
});

test('factorial rejects negative integers', () => {
  assert.throws(() => factorial(-1), /undefined for negative numbers/);
});
