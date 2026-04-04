/**
 * Unit tests for NotebookEditTool (notebook-edit.ts)
 * Tests via tool-names.ts and crew-adapter.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Build a minimal valid .ipynb notebook JSON */
function makeNotebook(cells = []) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells,
  };
}

function makeCodeCell(source) {
  const lines = source.split('\n');
  return {
    cell_type: 'code',
    source: lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)),
    metadata: {},
    outputs: [],
    execution_count: null,
  };
}

function makeMarkdownCell(source) {
  const lines = source.split('\n');
  return {
    cell_type: 'markdown',
    source: lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)),
    metadata: {},
  };
}

let tmpDir;
let nbPath;

before(() => {
  tmpDir = join(tmpdir(), `nb-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  nbPath = join(tmpDir, 'test.ipynb');
  const nb = makeNotebook([
    makeCodeCell('x = 1\nprint(x)'),
    makeMarkdownCell('# Header'),
    makeCodeCell('y = x + 1'),
  ]);
  writeFileSync(nbPath, JSON.stringify(nb, null, 2), 'utf8');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSandbox(dir) {
  return {
    baseDir: dir,
    addChange: async () => {},
    getPendingPaths: () => [],
    getStagedContent: () => null,
  };
}

describe('NotebookEditTool', () => {
  it('exports NOTEBOOK_EDIT_TOOL_NAME as "notebook_edit"', async () => {
    const { NOTEBOOK_EDIT_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.equal(NOTEBOOK_EDIT_TOOL_NAME, 'notebook_edit');
  });

  it('includes notebook_edit in ALL_BUILTIN_TOOL_NAMES', async () => {
    const { ALL_BUILTIN_TOOL_NAMES, NOTEBOOK_EDIT_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.ok(ALL_BUILTIN_TOOL_NAMES.includes(NOTEBOOK_EDIT_TOOL_NAME), 'notebook_edit should be in ALL_BUILTIN_TOOL_NAMES');
  });

  it('read action returns notebook structure', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'full');
    const result = await adapter.executeTool('notebook_edit', { action: 'read', path: nbPath });
    assert.ok(result, 'result must be defined');
    assert.ok('success' in result, 'result must have success');
    const output = result.output || '';
    assert.ok(output.includes('Cells:'), `Expected "Cells:" in output: ${output.slice(0, 200)}`);
  });

  it('add_cell appends a new code cell', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'full');
    const result = await adapter.executeTool('notebook_edit', {
      action: 'add_cell', path: nbPath, cell_type: 'code', content: 'z = 99',
    });
    assert.ok(result, 'result must be defined');
    assert.ok(result.success !== false, `add_cell should succeed: ${result.error}`);
    const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
    assert.equal(nb.cells.length, 4, 'notebook should now have 4 cells');
    assert.equal(nb.cells[3].cell_type, 'code');
  });

  it('add_cell inserts at a specific index', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'full');
    const nbBefore = JSON.parse(readFileSync(nbPath, 'utf8'));
    const countBefore = nbBefore.cells.length;
    const result = await adapter.executeTool('notebook_edit', {
      action: 'add_cell', path: nbPath, cell_type: 'markdown', content: '## Inserted', index: 0,
    });
    assert.ok(result.success !== false, `Should succeed: ${result.error}`);
    const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
    assert.equal(nb.cells.length, countBefore + 1);
    assert.equal(nb.cells[0].cell_type, 'markdown');
    const src = nb.cells[0].source.join('');
    assert.ok(src.includes('Inserted'), `Cell 0 should have "Inserted": ${src}`);
  });

  it('edit_cell updates source by index', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'full');
    const result = await adapter.executeTool('notebook_edit', {
      action: 'edit_cell', path: nbPath, index: 1, content: 'x = 100',
    });
    assert.ok(result.success !== false, `edit_cell should succeed: ${result.error}`);
    const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
    const src = nb.cells[1].source.join('');
    assert.ok(src.includes('100'), `Cell 1 should contain "100": ${src}`);
  });

  it('edit_cell with out-of-range index returns graceful error', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'full');
    const result = await adapter.executeTool('notebook_edit', {
      action: 'edit_cell', path: nbPath, index: 9999, content: 'bad',
    });
    // Should not throw, should return error output
    const output = result.output || result.error || '';
    assert.ok(
      output.includes('out of range') || output.includes('error') || !result.success,
      `Expected graceful error for out-of-range index: ${output}`,
    );
  });

  it('delete_cell removes a cell by index', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'full');
    const nbBefore = JSON.parse(readFileSync(nbPath, 'utf8'));
    const countBefore = nbBefore.cells.length;
    const result = await adapter.executeTool('notebook_edit', {
      action: 'delete_cell', path: nbPath, index: 0,
    });
    assert.ok(result.success !== false, `delete_cell should succeed: ${result.error}`);
    const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
    assert.equal(nb.cells.length, countBefore - 1, 'should have one fewer cell');
  });

  it('notebook_edit is allowed at edit constraint level', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'edit');
    const result = await adapter.executeTool('notebook_edit', { action: 'read', path: nbPath });
    assert.ok(
      !(result.error && result.error.includes('not available at constraint level')),
      'notebook_edit should be allowed at edit level',
    );
  });

  it('notebook_edit is blocked at read-only constraint level', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(tmpDir), 'read-only');
    // Even read action — notebook_edit is not in READ_ONLY_TOOLS
    const result = await adapter.executeTool('notebook_edit', { action: 'read', path: nbPath });
    assert.ok(
      result.success === false && result.error && result.error.includes('not available at constraint level'),
      `Expected constraint-level block, got: ${JSON.stringify(result)}`,
    );
  });
});
