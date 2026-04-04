/**
 * Unit tests for ToolSearchTool (tool-search.ts)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ToolSearchTool — unit', () => {
  it('should export TOOL_SEARCH_TOOL_NAME constant equal to "tool_search"', async () => {
    const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.equal(TOOL_SEARCH_TOOL_NAME, 'tool_search');
  });

  it('should include tool_search in ALL_BUILTIN_TOOL_NAMES', async () => {
    const { ALL_BUILTIN_TOOL_NAMES, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.ok(ALL_BUILTIN_TOOL_NAMES.includes(TOOL_SEARCH_TOOL_NAME), 'tool_search should be in ALL_BUILTIN_TOOL_NAMES');
  });

  it('TOOL_SEARCH_DEFINITION should have correct base structure', async () => {
    const { TOOL_SEARCH_DEFINITION } = await import('../../src/tools/gemini/definitions/coreTools.ts');
    assert.ok(TOOL_SEARCH_DEFINITION, 'TOOL_SEARCH_DEFINITION should exist');
    assert.equal(TOOL_SEARCH_DEFINITION.base.name, 'tool_search');
    assert.ok(TOOL_SEARCH_DEFINITION.base.description.length > 10, 'should have a meaningful description');
    assert.ok(TOOL_SEARCH_DEFINITION.base.parametersJsonSchema, 'should have parametersJsonSchema');
  });

  it('TOOL_SEARCH_DEFINITION schema should require query parameter', async () => {
    const { TOOL_SEARCH_DEFINITION } = await import('../../src/tools/gemini/definitions/coreTools.ts');
    const schema = TOOL_SEARCH_DEFINITION.base.parametersJsonSchema;
    assert.deepStrictEqual(schema.required, ['query']);
    assert.equal(schema.properties.query.type, 'string');
  });

  it('TOOL_SEARCH_DEFINITION schema should have optional max_results param', async () => {
    const { TOOL_SEARCH_DEFINITION } = await import('../../src/tools/gemini/definitions/coreTools.ts');
    const { properties } = TOOL_SEARCH_DEFINITION.base.parametersJsonSchema;
    assert.ok(properties.max_results, 'max_results should exist in schema');
    assert.equal(properties.max_results.type, 'number');
  });

  it('tool_search via adapter should find "shell" tool by name', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpdir(), addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');

    const result = await adapter.executeTool('tool_search', { query: 'shell' });
    assert.ok(result.success !== false, `tool_search should succeed: ${result.error}`);
    assert.ok(result.output, 'Should return output');

    const data = JSON.parse(result.output);
    assert.ok(data.count > 0, 'Should find at least one tool matching "shell"');
    assert.ok(Array.isArray(data.results), 'results should be an array');
  });

  it('tool_search should be allowed at read-only constraint level', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpdir(), addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'read-only');

    const result = await adapter.executeTool('tool_search', { query: 'read' });
    assert.ok(
      !(result.error && result.error.includes('not available at constraint level')),
      'tool_search should be allowed at read-only level'
    );
  });

  it('tool_search should return no results for nonsense query', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpdir(), addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');

    const result = await adapter.executeTool('tool_search', { query: 'zzzznonexistenttoolxxx' });
    assert.ok(result.success !== false || result.output, 'Should not throw');
    // Should return a "no tools found" message or empty results
    if (result.output) {
      const hasResults = result.output.includes('"count"') && JSON.parse(result.output).count > 0;
      assert.ok(!hasResults, 'Should not find tools for nonsense query');
    }
  });

  it('tool_search should respect max_results limit', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpdir(), addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');

    const result = await adapter.executeTool('tool_search', { query: 'file', max_results: 2 });
    assert.ok(result.success !== false, 'Should succeed');

    if (result.output && result.output.startsWith('{')) {
      const data = JSON.parse(result.output);
      if (Array.isArray(data.results)) {
        assert.ok(data.results.length <= 2, `Should return at most 2 results, got ${data.results.length}`);
      }
    }
  });

  it('tool_search should include tool name and description in results', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const fakeSandbox = { baseDir: tmpdir(), addChange: async () => {} };
    const adapter = new GeminiToolAdapter(fakeSandbox, 'full');

    const result = await adapter.executeTool('tool_search', { query: 'glob' });
    assert.ok(result.success !== false, 'Should succeed');

    if (result.output && result.output.startsWith('{')) {
      const data = JSON.parse(result.output);
      if (Array.isArray(data.results) && data.results.length > 0) {
        const first = data.results[0];
        assert.ok(first.name, 'result should have name');
        assert.ok(first.description, 'result should have description');
      }
    }
  });
});
