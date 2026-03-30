/**
 * Unit tests for crew-cli/src/cli/index.ts
 *
 * Tests the parseable, non-interactive exported functions:
 *  - parseHeadlessShortcutArgs: CLI argument parsing
 *  - parseConfigValue: string-to-typed conversion
 *
 * Skips: main() (starts interactive session / full CLI), all non-exported
 * functions (parseDiagnosticOutput, extractValidationSignals, etc.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeadlessShortcutArgs, parseConfigValue } from '../../src/cli/index.ts';

// ── parseHeadlessShortcutArgs ───────────────────────────────────────────────

describe('cli-commands — parseHeadlessShortcutArgs', () => {
  it('returns enabled:false when --headless not present', () => {
    const result = parseHeadlessShortcutArgs(['run', '-t', 'hello']);
    assert.equal(result.enabled, false);
  });

  it('returns enabled:true when --headless is present', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '-t', 'do something']);
    assert.equal(result.enabled, true);
  });

  it('parses --json flag', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '--json']);
    assert.equal(result.json, true);
  });

  it('parses --always-approve flag', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '--always-approve']);
    assert.equal(result.alwaysApprove, true);
  });

  it('parses --out value', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '--out', '/tmp/output.json']);
    assert.equal(result.out, '/tmp/output.json');
  });

  it('parses -t value', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '-t', 'my task']);
    assert.equal(result.task, 'my task');
  });

  it('parses --task value', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '--task', 'my task']);
    assert.equal(result.task, 'my task');
  });

  it('parses --agent value', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '--agent', 'crew-coder']);
    assert.equal(result.agent, 'crew-coder');
  });

  it('parses -g value', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '-g', 'http://localhost:5010']);
    assert.equal(result.gateway, 'http://localhost:5010');
  });

  it('parses --gateway value', () => {
    const result = parseHeadlessShortcutArgs(['--headless', '--gateway', 'http://remote:5010']);
    assert.equal(result.gateway, 'http://remote:5010');
  });

  it('returns undefined for missing optional values', () => {
    const result = parseHeadlessShortcutArgs(['--headless']);
    assert.equal(result.enabled, true);
    assert.equal(result.json, false);
    assert.equal(result.alwaysApprove, false);
    assert.equal(result.out, undefined);
    assert.equal(result.task, undefined);
    assert.equal(result.agent, undefined);
    assert.equal(result.gateway, undefined);
  });

  it('handles combined flags', () => {
    const result = parseHeadlessShortcutArgs([
      '--headless', '--json', '--always-approve',
      '-t', 'fix bug', '--agent', 'crew-fixer',
      '--out', '/tmp/r.json', '-g', 'http://gw:5010'
    ]);
    assert.equal(result.enabled, true);
    assert.equal(result.json, true);
    assert.equal(result.alwaysApprove, true);
    assert.equal(result.task, 'fix bug');
    assert.equal(result.agent, 'crew-fixer');
    assert.equal(result.out, '/tmp/r.json');
    assert.equal(result.gateway, 'http://gw:5010');
  });
});

// ── parseConfigValue ────────────────────────────────────────────────────────

describe('cli-commands — parseConfigValue', () => {
  it('parses "true" as boolean true', () => {
    assert.equal(parseConfigValue('true'), true);
  });

  it('parses "false" as boolean false', () => {
    assert.equal(parseConfigValue('false'), false);
  });

  it('parses "null" as null', () => {
    assert.equal(parseConfigValue('null'), null);
  });

  it('parses integer string as number', () => {
    assert.equal(parseConfigValue('42'), 42);
  });

  it('parses negative integer as number', () => {
    assert.equal(parseConfigValue('-5'), -5);
  });

  it('parses float string as number', () => {
    assert.equal(parseConfigValue('3.14'), 3.14);
  });

  it('returns plain string for non-special values', () => {
    assert.equal(parseConfigValue('hello'), 'hello');
  });

  it('trims whitespace', () => {
    assert.equal(parseConfigValue('  true  '), true);
    assert.equal(parseConfigValue('  42  '), 42);
    assert.equal(parseConfigValue('  hello  '), 'hello');
  });

  it('parses JSON when asJson=true', () => {
    const result = parseConfigValue('{"key": "value"}', true);
    assert.deepEqual(result, { key: 'value' });
  });

  it('parses JSON array when asJson=true', () => {
    const result = parseConfigValue('[1, 2, 3]', true);
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('throws for invalid JSON when asJson=true', () => {
    assert.throws(() => parseConfigValue('not json', true));
  });

  it('handles null/undefined input', () => {
    assert.equal(parseConfigValue(null), '');
    assert.equal(parseConfigValue(undefined), '');
  });
});
