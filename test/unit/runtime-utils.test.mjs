import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  median,
  percentile,
  formatDuration,
  formatError,
} from "../../lib/runtime/utils.mjs";

describe("median", () => {
  test("returns null for empty array", () => {
    assert.equal(median([]), null);
  });

  test("returns single element", () => {
    assert.equal(median([42]), 42);
  });

  test("returns middle value for odd-length array", () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  test("returns average of two middle values for even-length array", () => {
    assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 = 2.5 → Math.round = 3
  });

  test("handles unsorted input", () => {
    assert.equal(median([10, 1, 5, 3, 8]), 5);
  });

  test("handles negative numbers", () => {
    assert.equal(median([-3, -1, -2]), -2);
  });
});

describe("percentile", () => {
  test("returns null for empty array", () => {
    assert.equal(percentile([], 90), null);
  });

  test("p50 is equivalent to median for odd-length array", () => {
    const data = [1, 2, 3, 4, 5];
    assert.equal(percentile(data, 50), 3);
  });

  test("p100 returns max value", () => {
    const data = [10, 20, 30, 40, 50];
    assert.equal(percentile(data, 100), 50);
  });

  test("p0 returns min value", () => {
    const data = [10, 20, 30];
    assert.equal(percentile(data, 0), 10);
  });

  test("p95 on large array approaches the top", () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    const p95 = percentile(data, 95);
    assert.ok(p95 >= 94 && p95 <= 100, `p95 out of range: ${p95}`);
  });
});

describe("formatDuration", () => {
  test("formats sub-second durations as ms", () => {
    assert.equal(formatDuration(0), "0ms");
    assert.equal(formatDuration(500), "500ms");
    assert.equal(formatDuration(999), "999ms");
  });

  test("formats durations >= 1000ms as seconds", () => {
    assert.equal(formatDuration(1000), "1.00s");
    assert.equal(formatDuration(2500), "2.50s");
    assert.equal(formatDuration(60000), "60.00s");
  });
});

describe("formatError", () => {
  test("returns a string starting with the error emoji", () => {
    const result = formatError(new Error("something failed"));
    assert.ok(result.startsWith("❌"), `expected ❌ prefix, got: ${result.slice(0, 20)}`);
  });

  test("includes the error message", () => {
    const result = formatError(new Error("ENOENT: file not found"));
    assert.ok(result.includes("ENOENT"));
  });

  test("includes a connection hint for ECONNREFUSED", () => {
    const result = formatError(new Error("ECONNREFUSED 127.0.0.1:5010"));
    assert.ok(result.toLowerCase().includes("hint"), "expected a hint in output");
    assert.ok(result.toLowerCase().includes("gateway") || result.toLowerCase().includes("service"));
  });

  test("includes a timeout hint for timeout errors", () => {
    const result = formatError(new Error("request timeout"));
    assert.ok(result.toLowerCase().includes("timeout") || result.toLowerCase().includes("retry"));
  });

  test("handles non-Error objects gracefully", () => {
    const result = formatError("raw string error");
    assert.ok(result.startsWith("❌"));
    assert.ok(result.includes("raw string error"));
  });

  test("handles null/undefined without throwing", () => {
    assert.doesNotThrow(() => formatError(null));
    assert.doesNotThrow(() => formatError(undefined));
  });
});
