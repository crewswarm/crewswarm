import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProjectStructure, formatStructureContext } from '../../src/utils/structure-analyzer.ts';

describe('structure-analyzer', () => {
  it('analyzeProjectStructure returns StructureResult shape', () => {
    const result = analyzeProjectStructure(process.cwd());
    assert.equal(typeof result.language, 'string');
    assert.equal(typeof result.framework, 'string');
    assert.ok(Array.isArray(result.entryPoints));
    assert.ok(Array.isArray(result.directories));
    assert.equal(typeof result.fileCount, 'number');
    assert.equal(typeof result.hasTests, 'boolean');
    assert.equal(typeof result.hasConfig, 'boolean');
    assert.equal(typeof result.packageManager, 'string');
  });

  it('detects TypeScript for this project', () => {
    const result = analyzeProjectStructure(process.cwd());
    assert.ok(result.language.includes('TypeScript'));
  });

  it('formatStructureContext returns a string', () => {
    const result = analyzeProjectStructure(process.cwd());
    const ctx = formatStructureContext(result);
    assert.equal(typeof ctx, 'string');
    assert.ok(ctx.includes('Project:'));
  });

  it('handles nonexistent directory gracefully', () => {
    const result = analyzeProjectStructure('/tmp/nonexistent-dir-xyz-123');
    assert.equal(result.fileCount, 0);
  });
});
