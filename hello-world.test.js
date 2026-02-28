import { getHelloWorld } from './hello-world.js';
import assert from 'node:assert';
import { test } from 'node:test';

test('getHelloWorld returns "Hello, World!"', () => {
  const result = getHelloWorld();
  assert.strictEqual(result, "Hello, World!");
});
