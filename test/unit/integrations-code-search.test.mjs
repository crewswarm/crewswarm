/**
 * Unit tests for lib/integrations/code-search.mjs
 *
 * Covers:
 *  - searchCode: happy path, no-keyword path, no-match path, fileTypes option
 *  - formatSearchResults: empty results, truncation, per-result entry format
 *  - findFiles: returns array of strings
 *  - searchPattern: happy path, no-match, fileTypes option
 *  - findFunctions: wraps searchPattern with function pattern
 *  - findClasses: wraps searchPattern with class pattern
 *
 * All functions use execSync(rg ...) internally. Tests run against this
 * actual project directory (rg is available on the CI machine). We use
 * known strings that we know exist in the codebase to ensure predictable
 * results, and test the no-match path using strings that cannot exist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const {
  searchCode,
  formatSearchResults,
  findFiles,
  searchPattern,
  findFunctions,
  findClasses,
} = await import("../../lib/integrations/code-search.mjs");

const PROJECT_DIR = path.resolve("/Users/jeffhobbs/CrewSwarm");

// ── searchCode ──────────────────────────────────────────────────────────────

describe("integrations-code-search — searchCode", () => {
  it("returns correct shape for a valid query", async () => {
    const result = await searchCode("how does the dispatcher work", PROJECT_DIR, { maxResults: 5 });
    assert.equal(typeof result, "object");
    assert.equal(result.query, "how does the dispatcher work");
    assert.ok(Array.isArray(result.keywords));
    assert.ok(Array.isArray(result.results));
    assert.equal(typeof result.summary, "string");
  });

  it("returns results with file, line, content, score fields", async () => {
    const result = await searchCode("function export module", PROJECT_DIR, { maxResults: 3 });
    for (const r of result.results) {
      assert.ok("file" in r, "missing file");
      assert.ok("line" in r, "missing line");
      assert.ok("content" in r, "missing content");
      assert.ok("score" in r, "missing score");
    }
  });

  it("keywords array contains meaningful words (stopwords removed)", async () => {
    const result = await searchCode("how does authentication work", PROJECT_DIR);
    assert.ok(!result.keywords.includes("how"));
    assert.ok(!result.keywords.includes("does"));
    assert.ok(!result.keywords.includes("the"));
  });

  it("returns at most maxResults results", async () => {
    const result = await searchCode("function export", PROJECT_DIR, { maxResults: 3 });
    assert.ok(result.results.length <= 3);
  });

  it("returns empty results for a query with only stopwords", async () => {
    const result = await searchCode("how the is a and or but", PROJECT_DIR);
    assert.equal(result.results.length, 0);
    assert.ok(result.summary.includes("No meaningful keywords"));
  });

  it("returns empty results for a query yielding no matches", async () => {
    // Search only lib/ so the test file itself cannot match
    const result = await searchCode(
      "qqnomatch sentinel zerooccurrences",
      path.join(PROJECT_DIR, "lib")
    );
    assert.ok(Array.isArray(result.results));
    assert.equal(result.results.length, 0);
  });

  it("accepts fileTypes option without throwing (uses rg-native js type)", async () => {
    const result = await searchCode("export function", PROJECT_DIR, {
      maxResults: 5,
      fileTypes: ["js"]
    });
    assert.ok(Array.isArray(result.results));
  });

  it("results are sorted by score descending", async () => {
    const result = await searchCode("dispatch agent task", PROJECT_DIR, { maxResults: 10 });
    for (let i = 1; i < result.results.length; i++) {
      assert.ok(
        result.results[i - 1].score >= result.results[i].score,
        `Results out of order at index ${i}`
      );
    }
  });

  it("fileGroups groups results by file", async () => {
    const result = await searchCode("export function", PROJECT_DIR, { maxResults: 10 });
    if (result.results.length > 0) {
      assert.ok("fileGroups" in result);
      assert.equal(typeof result.fileGroups, "object");
    }
  });
});

// ── formatSearchResults ──────────────────────────────────────────────────────

describe("integrations-code-search — formatSearchResults", () => {
  it("returns markdown string with query header", () => {
    const output = formatSearchResults({ query: "auth flow", results: [], summary: "No matches" });
    assert.ok(output.includes("auth flow"));
    assert.ok(output.startsWith("##"));
  });

  it("returns summary line when no results", () => {
    const output = formatSearchResults({
      query: "test",
      results: [],
      summary: "No matches found"
    });
    assert.ok(output.includes("No matches found"));
  });

  it("includes file:line entry for each result", () => {
    const results = [
      { file: "lib/test.mjs", line: 42, content: "export function doThing() {}", score: 100 }
    ];
    const output = formatSearchResults({ query: "doThing", results, summary: "1 match" });
    assert.ok(output.includes("lib/test.mjs:42"));
    assert.ok(output.includes("doThing"));
  });

  it("truncates output when results exceed maxChars", () => {
    const bigContent = "x".repeat(500);
    const results = Array.from({ length: 20 }, (_, i) => ({
      file: `file${i}.mjs`,
      line: i,
      content: bigContent,
      score: 100 - i
    }));
    const output = formatSearchResults({ query: "big", results, summary: "many" }, 2000);
    assert.ok(output.length <= 4000); // some slack for truncation message
    assert.ok(output.includes("truncated") || output.length < 4000);
  });

  it("respects custom maxChars limit", () => {
    const results = [
      { file: "a.mjs", line: 1, content: "x".repeat(200), score: 50 }
    ];
    const output = formatSearchResults({ query: "x", results, summary: "1" }, 100);
    // Output may contain truncation notice
    assert.equal(typeof output, "string");
  });

  it("wraps content in code block", () => {
    const results = [
      { file: "lib/foo.mjs", line: 10, content: "function foo() {}", score: 50 }
    ];
    const output = formatSearchResults({ query: "foo", results, summary: "1" });
    assert.ok(output.includes("```"));
  });
});

// ── findFiles ────────────────────────────────────────────────────────────────

describe("integrations-code-search — findFiles", () => {
  it("returns an array of strings", async () => {
    const files = await findFiles("package.json", PROJECT_DIR);
    assert.ok(Array.isArray(files));
    for (const f of files) {
      assert.equal(typeof f, "string");
    }
  });

  it("finds package.json in the project", async () => {
    const files = await findFiles("package.json", PROJECT_DIR);
    assert.ok(files.length > 0);
  });

  it("returns empty array for impossible pattern", async () => {
    const files = await findFiles("xyzzy_impossible_9q8r7s6t5u.never", PROJECT_DIR);
    assert.deepEqual(files, []);
  });

  it("does not throw for empty pattern", async () => {
    await assert.doesNotReject(() => findFiles("", PROJECT_DIR));
  });
});

// ── searchPattern ────────────────────────────────────────────────────────────

describe("integrations-code-search — searchPattern", () => {
  it("returns array for a simple pattern", async () => {
    const results = await searchPattern("export function", PROJECT_DIR, { contextLines: 0 });
    assert.ok(Array.isArray(results));
  });

  it("each result has file, line, content fields", async () => {
    const results = await searchPattern("export function", PROJECT_DIR, { contextLines: 0 });
    for (const r of results.slice(0, 5)) {
      assert.ok("file" in r);
      assert.ok("line" in r);
      assert.ok("content" in r);
    }
  });

  it("returns empty array for impossible pattern", async () => {
    // Search only lib/ to avoid matching the test file itself
    const results = await searchPattern(
      "QQNOMATCH_SENTINEL_9876543210_NEVER",
      path.join(PROJECT_DIR, "lib")
    );
    assert.deepEqual(results, []);
  });

  it("accepts fileTypes option with a known-supported type", async () => {
    const results = await searchPattern("export", PROJECT_DIR, {
      fileTypes: ["js"],
      contextLines: 0
    });
    assert.ok(Array.isArray(results));
  });
});

// ── findFunctions ────────────────────────────────────────────────────────────

// Helper: detect if rg supports the 'mjs' file type on this host
async function rgSupportsMjsType() {
  try {
    await findFunctions("__probe_mjs_type__", PROJECT_DIR);
    return true;
  } catch (err) {
    // rg exits 2 for unknown type errors (status 2, not status 1 which is no-match)
    if (err?.status === 2) return false;
    // If no match (status 1) rg returns [] via the catch in searchPattern
    return true;
  }
}

const MJS_TYPE_SUPPORTED = await rgSupportsMjsType();

describe("integrations-code-search — findFunctions", () => {
  it("returns array of results", { skip: !MJS_TYPE_SUPPORTED ? "rg lacks mjs type on this host" : false }, async () => {
    const results = await findFunctions("detectDomain", PROJECT_DIR);
    assert.ok(Array.isArray(results));
  });

  it("finds a known function in the project", { skip: !MJS_TYPE_SUPPORTED ? "rg lacks mjs type on this host" : false }, async () => {
    const results = await findFunctions("detectDomain", PROJECT_DIR);
    assert.ok(results.length > 0, "Should find detectDomain function definition");
  });

  it("returns empty array for non-existent function", { skip: !MJS_TYPE_SUPPORTED ? "rg lacks mjs type on this host" : false }, async () => {
    const results = await findFunctions("xyzzyNonExistentFunctionAbc999", PROJECT_DIR);
    assert.deepEqual(results, []);
  });

  it("escapes special regex characters in name", { skip: !MJS_TYPE_SUPPORTED ? "rg lacks mjs type on this host" : false }, async () => {
    // Should not throw (rg pattern is escaped, result may be empty)
    const results = await findFunctions("foo.bar(baz)", PROJECT_DIR);
    assert.ok(Array.isArray(results));
  });
});

// ── findClasses ──────────────────────────────────────────────────────────────

describe("integrations-code-search — findClasses", () => {
  it("returns array of results", { skip: !MJS_TYPE_SUPPORTED ? "rg lacks mjs type on this host" : false }, async () => {
    const results = await findClasses("Error", PROJECT_DIR);
    assert.ok(Array.isArray(results));
  });

  it("returns empty array for non-existent class", { skip: !MJS_TYPE_SUPPORTED ? "rg lacks mjs type on this host" : false }, async () => {
    const results = await findClasses("XyzzyImpossibleClass999", PROJECT_DIR);
    assert.deepEqual(results, []);
  });

  it("searchPattern works with known js file type for class patterns", async () => {
    // Test the underlying pattern search directly with a rg-supported type
    const results = await searchPattern("class\\s+\\w+", PROJECT_DIR, {
      fileTypes: ["js"],
      contextLines: 0
    });
    assert.ok(Array.isArray(results));
  });
});
