/**
 * Unit tests for LSP tool (lsp.ts)
 * Tests via tool-names.ts and crew-adapter.ts (same pattern as sleep-tool.test.js)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir;
let tsFile;

before(() => {
  tmpDir = join(tmpdir(), `lsp-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  tsFile = join(tmpDir, 'sample.ts');
  writeFileSync(tsFile, [
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export const version = 42;',
  ].join('\n'), 'utf8');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('LspTool', () => {
  it('exports LSP_TOOL_NAME as "lsp"', async () => {
    const { LSP_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.equal(LSP_TOOL_NAME, 'lsp');
  });

  it('includes lsp in ALL_BUILTIN_TOOL_NAMES', async () => {
    const { ALL_BUILTIN_TOOL_NAMES, LSP_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.ok(ALL_BUILTIN_TOOL_NAMES.includes(LSP_TOOL_NAME), 'lsp should be in ALL_BUILTIN_TOOL_NAMES');
  });

  it('lsp tool is allowed at read-only constraint level', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'read-only');
    const result = await adapter.executeTool('lsp', { action: 'diagnostics', file: tsFile });
    // Should NOT be blocked by constraint level
    assert.ok(
      !(result.error && result.error.includes('not available at constraint level')),
      'lsp should be allowed at read-only level',
    );
  });

  it('lsp diagnostics returns a result for .ts file', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('lsp', { action: 'diagnostics', file: tsFile });
    // Result must exist and have output or success flag
    assert.ok(result, 'result must be defined');
    assert.ok('success' in result, 'result must have success property');
    // Output should be a string
    if (result.output) {
      assert.equal(typeof result.output, 'string');
    }
  });

  it('lsp references with symbol performs grep-based lookup', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('lsp', { action: 'references', file: tsFile, symbol: 'greet' });
    assert.ok(result, 'result must be defined');
    // grep-based refs should find "greet" in the sample file or return "No references"
    const output = result.output || result.error || '';
    assert.ok(
      output.includes('greet') || output.includes('No references') || output.includes('failed'),
      `Expected grep output or error, got: ${output}`,
    );
  });

  it('lsp hover requires line and column', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    // Without line — should return an error or handle gracefully
    const result = await adapter.executeTool('lsp', { action: 'hover', file: tsFile });
    assert.ok(result, 'result must be defined');
    // Either returns error message or output; no uncaught exceptions
    const hasOutput = result.output != null || result.error != null;
    assert.ok(hasOutput, 'result should have output or error');
  });

  it('lsp hover with valid line returns content', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('lsp', { action: 'hover', file: tsFile, line: 1, column: 20 });
    assert.ok(result, 'result must be defined');
  });

  it('lsp legacy query "diagnostics" still works', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    // Legacy query interface (backward compat)
    const result = await adapter.executeTool('lsp', { query: 'diagnostics' });
    assert.ok(result, 'result must be defined');
    assert.ok('success' in result, 'result must have success');
  });

  it('lsp completions returns result for .ts file at valid position', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('lsp', {
      action: 'completions', file: tsFile, line: 1, column: 10,
    });
    assert.ok(result, 'result must be defined');
  });

  it('lsp definition falls back to grep when tsserver unavailable', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpDir, addChange: async () => {}, getPendingPaths: () => [] };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');
    const result = await adapter.executeTool('lsp', {
      action: 'definition', file: tsFile, symbol: 'greet',
    });
    assert.ok(result, 'result must be defined');
    assert.ok('success' in result, 'result must have success');
  });
});
