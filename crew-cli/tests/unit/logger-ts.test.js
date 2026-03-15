import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../../src/utils/logger.ts';

test('Logger (ts) formats message with prefix, level, and content', () => {
  const logger = new Logger({ prefix: '[Unit]' });
  const line = logger.formatMessage('info', 'hello world');

  assert.match(line, /\[Unit\]/);
  assert.match(line, /\[INFO\]/);
  assert.match(line, /hello world/);
});

test('Logger (ts) debug only logs when level=debug', () => {
  const originalLog = console.log;
  const seen = [];
  console.log = (...args) => seen.push(args.join(' '));

  try {
    new Logger({ level: 'info' }).debug('hidden');
    new Logger({ level: 'debug' }).debug('shown');
  } finally {
    console.log = originalLog;
  }

  assert.equal(seen.length, 1);
  assert.match(seen[0], /\[DEBUG\]/);
  assert.match(seen[0], /shown/);
});

test('Logger (ts) highlightCodeBlocks leaves plain text unchanged', () => {
  const logger = new Logger();
  const input = 'no fenced code here';
  assert.equal(logger.highlightCodeBlocks(input), input);
});

test('Logger (ts) highlightCodeBlocks preserves fenced sections', () => {
  const logger = new Logger();
  const input = 'before\n```js\nconst x = 1;\n```\nafter';
  const output = logger.highlightCodeBlocks(input);

  assert.match(output, /before/);
  assert.match(output, /```js/);
  assert.match(output, /const x = 1;/);
  assert.match(output, /after/);
});

test('Logger (ts) highlightDiff preserves diff semantics', () => {
  const logger = new Logger();
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new', ' context'].join('\n');
  const output = logger.highlightDiff(diff);

  assert.match(output, /^diff --git/m);
  assert.match(output, /^--- a\/a\.ts/m);
  assert.match(output, /^\+\+\+ b\/a\.ts/m);
  assert.match(output, /^@@ -1,1 \+1,1 @@/m);
  assert.match(output, /^-old/m);
  assert.match(output, /^\+new/m);
});

test('Logger (ts) progress clamps values and prints percent', () => {
  const originalLog = console.log;
  const seen = [];
  console.log = (...args) => seen.push(args.join(' '));

  try {
    const logger = new Logger();
    logger.progress(30, 10, 'Task');
    logger.progress(-5, 10, 'Task');
  } finally {
    console.log = originalLog;
  }

  assert.equal(seen.length, 2);
  assert.match(seen[0], /Task/);
  assert.match(seen[0], /100% \(10\/10\)/);
  assert.match(seen[1], /0% \(0\/10\)/);
});
