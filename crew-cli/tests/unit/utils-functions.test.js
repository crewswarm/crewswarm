/**
 * Unit tests for crew-cli/src/utils/functions.ts
 *
 * Covers:
 *  - utilityFunctions: non-empty catalog array
 *  - findUtilities: search by name, category, description
 *  - getCategories: returns unique sorted categories
 *  - getUtilitiesByCategory: filters by category
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  utilityFunctions,
  findUtilities,
  getCategories,
  getUtilitiesByCategory,
} from '../../src/utils/functions.ts';

// ── utilityFunctions catalog ────────────────────────────────────────────────

describe('utils/functions — utilityFunctions catalog', () => {
  it('is a non-empty array', () => {
    assert.ok(Array.isArray(utilityFunctions));
    assert.ok(utilityFunctions.length > 0);
  });

  it('each entry has required fields', () => {
    for (const func of utilityFunctions) {
      assert.equal(typeof func.name, 'string', `name should be string: ${JSON.stringify(func)}`);
      assert.equal(typeof func.file, 'string', `file should be string for ${func.name}`);
      assert.equal(typeof func.description, 'string', `description should be string for ${func.name}`);
      assert.equal(typeof func.category, 'string', `category should be string for ${func.name}`);
    }
  });

  it('has entries from multiple files', () => {
    const files = new Set(utilityFunctions.map(f => f.file));
    assert.ok(files.size > 3, `expected entries from multiple files, got ${files.size}`);
  });
});

// ── findUtilities ───────────────────────────────────────────────────────────

describe('utils/functions — findUtilities', () => {
  it('finds by function name', () => {
    const results = findUtilities('safeJsonParse');
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.name === 'safeJsonParse'));
  });

  it('finds by category', () => {
    const results = findUtilities('memory');
    assert.ok(results.length > 0);
    assert.ok(results.every(r =>
      r.name.toLowerCase().includes('memory') ||
      r.category.toLowerCase().includes('memory') ||
      r.description.toLowerCase().includes('memory')
    ));
  });

  it('finds by description keyword', () => {
    const results = findUtilities('checkpoint');
    assert.ok(results.length > 0);
  });

  it('returns empty array for no match', () => {
    const results = findUtilities('xyznonexistent12345');
    assert.deepEqual(results, []);
  });

  it('is case insensitive', () => {
    const lower = findUtilities('pipeline');
    const upper = findUtilities('PIPELINE');
    assert.equal(lower.length, upper.length);
  });
});

// ── getCategories ───────────────────────────────────────────────────────────

describe('utils/functions — getCategories', () => {
  it('returns sorted array of strings', () => {
    const categories = getCategories();
    assert.ok(Array.isArray(categories));
    assert.ok(categories.length > 0);
    // Verify sorted
    for (let i = 1; i < categories.length; i++) {
      assert.ok(categories[i] >= categories[i - 1], `expected sorted, got ${categories[i - 1]} before ${categories[i]}`);
    }
  });

  it('contains expected categories', () => {
    const categories = getCategories();
    assert.ok(categories.includes('memory'));
    assert.ok(categories.includes('pipeline'));
    assert.ok(categories.includes('parsing'));
  });

  it('has no duplicates', () => {
    const categories = getCategories();
    const unique = new Set(categories);
    assert.equal(categories.length, unique.size);
  });
});

// ── getUtilitiesByCategory ──────────────────────────────────────────────────

describe('utils/functions — getUtilitiesByCategory', () => {
  it('returns entries matching the category', () => {
    const memoryUtils = getUtilitiesByCategory('memory');
    assert.ok(memoryUtils.length > 0);
    for (const util of memoryUtils) {
      assert.equal(util.category, 'memory');
    }
  });

  it('returns empty for nonexistent category', () => {
    const results = getUtilitiesByCategory('nonexistent-category-xyz');
    assert.deepEqual(results, []);
  });

  it('pipeline category has pipeline entries', () => {
    const results = getUtilitiesByCategory('pipeline');
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.name === 'createContextPack' || r.name === 'executePipeline'));
  });
});
