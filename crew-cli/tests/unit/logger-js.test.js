import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../../src/utils/logger.js';

test('Logger (js) formats messages with prefix and uppercase level', () => {
  const logger = new Logger({ prefix: '[Legacy]' });
  const line = logger.formatMessage('warn', 'careful');

  assert.match(line, /\[Legacy\]/);
  assert.match(line, /\[WARN\]/);
  assert.match(line, /careful/);
});

test('Logger (js) info/warn/error route to expected console methods', () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const calls = { log: 0, warn: 0, error: 0 };
  console.log = () => { calls.log += 1; };
  console.warn = () => { calls.warn += 1; };
  console.error = () => { calls.error += 1; };

  try {
    const logger = new Logger();
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.success('s');
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(calls.log, 2);
  assert.equal(calls.warn, 1);
  assert.equal(calls.error, 1);
});

test('Logger (js) debug logs only when level=debug', () => {
  const originalLog = console.log;
  const seen = [];
  console.log = (...args) => seen.push(args.join(' '));

  try {
    new Logger({ level: 'info' }).debug('hidden');
    new Logger({ level: 'debug' }).debug('visible');
  } finally {
    console.log = originalLog;
  }

  assert.equal(seen.length, 1);
  assert.match(seen[0], /\[DEBUG\]/);
  assert.match(seen[0], /visible/);
});
