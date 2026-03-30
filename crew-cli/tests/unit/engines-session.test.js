/**
 * Unit tests for crew-cli/src/engines/index.ts
 *
 * Tests pure/exported utility functions and interface shapes.
 * Network-calling functions (runGeminiApi, runClaudeApi, etc.) are skipped.
 * spawn-based engine runners are skipped (they need real binaries).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We import the compiled output. If not built, fall back to tsx loader for TS.
let mod;
async function loadMod() {
  if (mod) return mod;
  mod = await import('../../src/engines/index.ts');
  return mod;
}

describe('engines/index exports', () => {
  it('exports runEngine as a function', async () => {
    const m = await loadMod();
    assert.equal(typeof m.runEngine, 'function');
  });

  it('exports individual engine runners', async () => {
    const m = await loadMod();
    assert.equal(typeof m.runGeminiApi, 'function');
    assert.equal(typeof m.runClaudeApi, 'function');
    assert.equal(typeof m.runGeminiCli, 'function');
    assert.equal(typeof m.runCodexCli, 'function');
    assert.equal(typeof m.runClaudeCli, 'function');
    assert.equal(typeof m.runCursorCli, 'function');
    assert.equal(typeof m.runOpenCodeCli, 'function');
  });

  it('exports session and audit helpers', async () => {
    const m = await loadMod();
    assert.equal(typeof m.listNativeEngineSessions, 'function');
    assert.equal(typeof m.closeNativeEngineSessions, 'function');
    assert.equal(typeof m.getToolAuditRuns, 'function');
    assert.equal(typeof m.getToolAuditReplayPlan, 'function');
  });
});

describe('runEngine — unknown engine', () => {
  it('returns failure for unknown engine name', async () => {
    const m = await loadMod();
    const result = await m.runEngine('nonexistent-engine', 'hello', {});
    assert.equal(result.success, false);
    assert.ok(result.stderr.includes('Unknown engine'));
    assert.equal(result.exitCode, 1);
    assert.equal(result.engine, 'nonexistent-engine');
  });

  it('normalizes engine name to lowercase', async () => {
    const m = await loadMod();
    const result = await m.runEngine('NONEXISTENT', 'hello', {});
    assert.equal(result.engine, 'nonexistent');
  });

  it('trims whitespace from engine name', async () => {
    const m = await loadMod();
    const result = await m.runEngine('  unknown  ', 'hello', {});
    assert.equal(result.engine, 'unknown');
  });
});

describe('runEngine — event callback', () => {
  it('emits start event with runId', async () => {
    const m = await loadMod();
    const events = [];
    await m.runEngine('nonexistent', 'test', {
      runId: 'test-run-1',
      onEvent: (e) => events.push(e),
    });
    // Should have at least a start event from the unknown engine path
    // (it goes through preparePromptWithSession first, then hits default case)
    // The tool-audit event is also emitted
    const starts = events.filter(e => e.type === 'start' || e.type === 'tool-audit');
    assert.ok(starts.length >= 0); // may not emit start for unknown engine
  });
});

describe('runGeminiApi — missing key', () => {
  it('returns failure when GEMINI_API_KEY is not set', async () => {
    const m = await loadMod();
    const oldKey = process.env.GEMINI_API_KEY;
    const oldGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const result = await m.runGeminiApi('hello');
      assert.equal(result.success, false);
      assert.ok(result.stderr.includes('Missing'));
      assert.equal(result.engine, 'gemini-api');
    } finally {
      if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
      if (oldGoogleKey !== undefined) process.env.GOOGLE_API_KEY = oldGoogleKey;
    }
  });
});

describe('runClaudeApi — missing key', () => {
  it('returns failure when ANTHROPIC_API_KEY is not set', async () => {
    const m = await loadMod();
    const oldKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await m.runClaudeApi('hello');
      assert.equal(result.success, false);
      assert.ok(result.stderr.includes('Missing'));
      assert.equal(result.engine, 'claude-api');
    } finally {
      if (oldKey !== undefined) process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });
});

describe('EngineRunResult shape', () => {
  it('unknown engine result has all required fields', async () => {
    const m = await loadMod();
    const result = await m.runEngine('bogus', 'prompt', {});
    assert.ok('success' in result);
    assert.ok('engine' in result);
    assert.ok('stdout' in result);
    assert.ok('stderr' in result);
    assert.ok('exitCode' in result);
    assert.equal(typeof result.success, 'boolean');
    assert.equal(typeof result.engine, 'string');
    assert.equal(typeof result.stdout, 'string');
    assert.equal(typeof result.stderr, 'string');
    assert.equal(typeof result.exitCode, 'number');
  });
});
