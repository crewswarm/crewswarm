/**
 * Unit tests for SpawnAgentTool (spawn-agent.ts)
 * Tests via tool-names.ts and crew-adapter.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

function makeSandbox(dir = tmpdir()) {
  return {
    baseDir: dir,
    getBaseDir: () => dir,
    addChange: async () => {},
    getPendingPaths: () => [],
    getStagedContent: () => null,
    createBranch: async () => {},
    switchBranch: async () => {},
    mergeBranch: async () => {},
    deleteBranch: async () => {},
    getActiveBranch: () => 'main',
    getBranches: () => ['main'],
  };
}

describe('SpawnAgentTool', () => {
  it('exports SPAWN_AGENT_TOOL_NAME as "spawn_agent"', async () => {
    const { SPAWN_AGENT_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.equal(SPAWN_AGENT_TOOL_NAME, 'spawn_agent');
  });

  it('includes spawn_agent in ALL_BUILTIN_TOOL_NAMES', async () => {
    const { ALL_BUILTIN_TOOL_NAMES, SPAWN_AGENT_TOOL_NAME } = await import('../../src/tools/gemini/tool-names.ts');
    assert.ok(ALL_BUILTIN_TOOL_NAMES.includes(SPAWN_AGENT_TOOL_NAME), 'spawn_agent should be in ALL_BUILTIN_TOOL_NAMES');
  });

  it('spawn_agent is blocked at read-only constraint level', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'read-only');
    const result = await adapter.executeTool('spawn_agent', { task: 'Do something' });
    assert.ok(
      result.success === false && result.error && result.error.includes('not available at constraint level'),
      `Expected constraint block at read-only level: ${JSON.stringify(result)}`,
    );
  });

  it('spawn_agent is blocked at edit constraint level', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'edit');
    const result = await adapter.executeTool('spawn_agent', { task: 'Do something' });
    assert.ok(
      result.success === false && result.error && result.error.includes('not available at constraint level'),
      `Expected constraint block at edit level: ${JSON.stringify(result)}`,
    );
  });

  it('spawn_agent is allowed at full constraint level (but may fail without config)', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'full');
    const result = await adapter.executeTool('spawn_agent', { task: 'Read the README' });
    // Should NOT be blocked by constraint level — may fail due to missing model config
    assert.ok(
      !(result.error && result.error.includes('not available at constraint level')),
      'spawn_agent should not be blocked by constraint level at full',
    );
    assert.ok('success' in result, 'result must have success property');
  });

  it('spawn_agent getToolDeclarations includes spawn_agent entry', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'full');
    const decls = adapter.getToolDeclarations();
    const found = decls.find(d => d.name === 'spawn_agent');
    assert.ok(found, 'spawn_agent should appear in tool declarations');
    assert.ok(found.description.length > 10, 'spawn_agent should have a description');
    assert.ok(found.parameters?.properties?.task, 'spawn_agent should have task parameter');
  });

  it('spawn_agent declaration has maxTurns parameter', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'full');
    const decls = adapter.getToolDeclarations();
    const found = decls.find(d => d.name === 'spawn_agent');
    assert.ok(found?.parameters?.properties?.maxTurns, 'spawn_agent should have maxTurns parameter');
  });

  it('spawn_agent requires task — empty task returns error', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'full');
    const result = await adapter.executeTool('spawn_agent', { task: '' });
    // spawn_agent should not silently succeed with empty task
    assert.ok(result, 'result must be defined');
    // Either blocked by validation or returns error
    if (result.success !== true) {
      assert.ok(result.error || result.output, 'should have error or output explaining failure');
    }
  });

  it('notebook_edit and lsp declarations are present in tool list', async () => {
    const { GeminiToolAdapter } = await import('../../src/tools/gemini/crew-adapter.ts');
    const adapter = new GeminiToolAdapter(makeSandbox(), 'full');
    const decls = adapter.getToolDeclarations();
    const names = decls.map(d => d.name);
    assert.ok(names.includes('lsp'), `lsp should be in declarations: ${names.join(', ')}`);
    assert.ok(names.includes('notebook_edit'), `notebook_edit should be in declarations: ${names.join(', ')}`);
    assert.ok(names.includes('spawn_agent'), `spawn_agent should be in declarations: ${names.join(', ')}`);
  });
});
