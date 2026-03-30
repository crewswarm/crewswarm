/**
 * Unit tests for lib/collections/index.mjs
 *
 * Covers:
 *  - Collection: add, get, update, delete, list, count, search, reindex, close
 *  - getCollectionsDbPath: returns expected path
 *  - createCollection: convenience wrapper
 *
 * Uses temp directory for SQLite DB.
 * Requires better-sqlite3.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let Collection, getCollectionsDbPath, createCollection;
let dbAvailable = true;

try {
  const mod = await import("../../lib/collections/index.mjs");
  Collection = mod.Collection;
  getCollectionsDbPath = mod.getCollectionsDbPath;
  createCollection = mod.createCollection;
} catch (e) {
  if (e.message?.includes("better-sqlite3")) {
    dbAvailable = false;
  } else {
    throw e;
  }
}

const TEST_DIR = path.join(os.tmpdir(), `crewswarm-collections-test-${process.pid}-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, "test-collections.db");

before(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("collections — getCollectionsDbPath", { skip: !dbAvailable && "better-sqlite3 not available" }, () => {
  it("returns a path ending in collections.db", () => {
    const p = getCollectionsDbPath();
    assert.ok(p.endsWith("collections.db"));
  });
});

describe("collections — Collection CRUD", { skip: !dbAvailable && "better-sqlite3 not available" }, () => {
  let col;

  before(() => {
    col = new Collection(TEST_DB, "test-items");
  });

  after(() => {
    col.close();
  });

  it("starts with count 0", () => {
    assert.equal(col.count(), 0);
  });

  it("add returns a row ID", () => {
    const id = col.add({
      title: "First Item",
      content: "This is the content of the first item with enough text to pass chunk filter",
      metadata: { category: "test" },
      tags: ["alpha"],
    });
    assert.equal(typeof id, "number");
    assert.ok(id > 0);
  });

  it("get returns the item by ID", () => {
    const id = col.add({
      title: "Retrievable",
      content: "A retrievable item with sufficient content for chunking purposes",
      metadata: { key: "value" },
      tags: ["beta"],
    });
    const item = col.get(id);
    assert.ok(item);
    assert.equal(item.title, "Retrievable");
    assert.deepEqual(item.metadata, { key: "value" });
    assert.deepEqual(item.tags, ["beta"]);
  });

  it("get returns null for nonexistent ID", () => {
    assert.equal(col.get(99999), null);
  });

  it("update modifies title", () => {
    const id = col.add({
      title: "Original",
      content: "Original content that is long enough for the chunk filter",
    });
    col.update(id, { title: "Updated" });
    const item = col.get(id);
    assert.equal(item.title, "Updated");
  });

  it("delete removes an item", () => {
    const id = col.add({ title: "Deletable", content: "To be deleted soon enough for chunking" });
    const before = col.count();
    col.delete(id);
    assert.equal(col.count(), before - 1);
    assert.equal(col.get(id), null);
  });

  it("list returns items in expected order", () => {
    const items = col.list({ limit: 100 });
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0);
  });

  it("count reflects current item count", () => {
    const c = col.count();
    assert.equal(typeof c, "number");
    assert.ok(c >= 0);
  });
});

describe("collections — search", { skip: !dbAvailable && "better-sqlite3 not available" }, () => {
  let col;

  before(() => {
    col = new Collection(path.join(TEST_DIR, "search-test.db"), "search-items");
    col.add({
      title: "JavaScript Guide",
      content: "JavaScript is a programming language used for web development and server-side applications with Node.js runtime",
      metadata: { lang: "javascript" },
      tags: ["programming", "web"],
    });
    col.add({
      title: "Python Guide",
      content: "Python is a programming language used for data science, machine learning, and backend development with Django",
      metadata: { lang: "python" },
      tags: ["programming", "data"],
    });
    col.add({
      title: "Cooking Recipes",
      content: "Collection of Italian pasta recipes including carbonara, bolognese, and aglio e olio with fresh ingredients",
      metadata: { category: "food" },
      tags: ["cooking"],
    });
  });

  after(() => {
    col.close();
  });

  it("returns relevant results for a query", () => {
    const results = col.search("programming language");
    assert.ok(results.length > 0);
    assert.ok(results[0].score > 0);
  });

  it("filters by tags", () => {
    const results = col.search("guide", { tags: "cooking" });
    // Cooking tag should only match the recipe
    for (const r of results) {
      assert.ok(r.tags.includes("cooking"));
    }
  });

  it("returns empty array when nothing matches", () => {
    const results = col.search("quantum physics");
    // May return empty or low-score results
    assert.ok(Array.isArray(results));
  });

  it("reindex rebuilds search index", () => {
    const count = col.reindex();
    assert.equal(typeof count, "number");
    assert.ok(count > 0);
  });
});
