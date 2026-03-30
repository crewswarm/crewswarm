import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, findModelInfo, formatModelTable } from '../../src/repl/model-info.ts';

describe('model-info', () => {
  it('MODEL_CATALOG is a non-empty array', () => {
    assert.ok(Array.isArray(MODEL_CATALOG));
    assert.ok(MODEL_CATALOG.length > 0);
  });

  it('findModelInfo finds a known model', () => {
    const info = findModelInfo('grok-4');
    assert.ok(info);
    assert.equal(info.provider, 'xAI');
  });

  it('findModelInfo returns undefined for unknown model', () => {
    const info = findModelInfo('completely-unknown-model-xyz');
    assert.equal(info, undefined);
  });

  it('formatModelTable returns a formatted string', () => {
    const table = formatModelTable(MODEL_CATALOG.slice(0, 3));
    assert.equal(typeof table, 'string');
    assert.ok(table.includes('Model'));
    assert.ok(table.includes('Score'));
  });

  it('each catalog entry has required fields', () => {
    for (const m of MODEL_CATALOG) {
      assert.equal(typeof m.name, 'string');
      assert.equal(typeof m.provider, 'string');
      assert.equal(typeof m.codingScore, 'number');
      assert.ok(['heavy', 'standard', 'fast'].includes(m.tier));
    }
  });
});
