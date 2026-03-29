import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStreamingDisabled } from '../../src/executor/stream-helpers.ts';

test('isStreamingDisabled returns false by default', () => {
  delete process.env.CREW_NO_STREAM;
  assert.equal(isStreamingDisabled(), false);
});

test('isStreamingDisabled returns true when CREW_NO_STREAM=true', () => {
  process.env.CREW_NO_STREAM = 'true';
  assert.equal(isStreamingDisabled(), true);
  delete process.env.CREW_NO_STREAM;
});

test('isStreamingDisabled is case-insensitive', () => {
  process.env.CREW_NO_STREAM = 'TRUE';
  assert.equal(isStreamingDisabled(), true);
  process.env.CREW_NO_STREAM = 'True';
  assert.equal(isStreamingDisabled(), true);
  delete process.env.CREW_NO_STREAM;
});

test('isStreamingDisabled returns false for non-true values', () => {
  process.env.CREW_NO_STREAM = 'false';
  assert.equal(isStreamingDisabled(), false);
  process.env.CREW_NO_STREAM = '0';
  assert.equal(isStreamingDisabled(), false);
  process.env.CREW_NO_STREAM = '';
  assert.equal(isStreamingDisabled(), false);
  delete process.env.CREW_NO_STREAM;
});
