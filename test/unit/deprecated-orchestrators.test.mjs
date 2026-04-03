/**
 * Unit tests for deprecated orchestrator stubs:
 *   - phased-orchestrator.mjs
 *   - continuous-build.mjs
 *
 * Both are 23-line stubs that:
 *   1. Print a deprecation message to stderr
 *   2. Suggest pm-loop.mjs as replacement
 *   3. Exit with code 1
 *
 * We spawn each as a child process and verify all three behaviors.
 * No imports from the stubs are needed (they export nothing).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const PHASED = new URL("../../phased-orchestrator.mjs", import.meta.url).pathname;
const CONTINUOUS = new URL("../../continuous-build.mjs", import.meta.url).pathname;

// ─── phased-orchestrator.mjs ──────────────────────────────────────────────────

describe("phased-orchestrator.mjs — deprecated stub", () => {
  it("exits with code 1", () => {
    const result = spawnSync("node", [PHASED], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
  });

  it("prints DEPRECATED message to stderr", () => {
    const result = spawnSync("node", [PHASED], { encoding: "utf8", timeout: 10_000 });
    assert.ok(
      result.stderr.includes("DEPRECATED"),
      `Expected 'DEPRECATED' in stderr. Got: ${result.stderr.slice(0, 300)}`
    );
  });

  it("recommends pm-loop.mjs on stderr", () => {
    const result = spawnSync("node", [PHASED], { encoding: "utf8", timeout: 10_000 });
    assert.ok(
      result.stderr.includes("pm-loop.mjs"),
      `Expected 'pm-loop.mjs' in stderr. Got: ${result.stderr.slice(0, 300)}`
    );
  });

  it("produces no stdout output", () => {
    const result = spawnSync("node", [PHASED], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.stdout.trim(), "", `Expected empty stdout. Got: ${result.stdout.slice(0, 200)}`);
  });

  it("mentions phased-orchestrator.mjs in stderr message", () => {
    const result = spawnSync("node", [PHASED], { encoding: "utf8", timeout: 10_000 });
    assert.ok(
      result.stderr.includes("phased-orchestrator.mjs"),
      `Expected file name in stderr. Got: ${result.stderr.slice(0, 300)}`
    );
  });
});

// ─── continuous-build.mjs ─────────────────────────────────────────────────────

describe("continuous-build.mjs — deprecated stub", () => {
  it("exits with code 1", () => {
    const result = spawnSync("node", [CONTINUOUS], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
  });

  it("prints DEPRECATED message to stderr", () => {
    const result = spawnSync("node", [CONTINUOUS], { encoding: "utf8", timeout: 10_000 });
    assert.ok(
      result.stderr.includes("DEPRECATED"),
      `Expected 'DEPRECATED' in stderr. Got: ${result.stderr.slice(0, 300)}`
    );
  });

  it("recommends pm-loop.mjs on stderr", () => {
    const result = spawnSync("node", [CONTINUOUS], { encoding: "utf8", timeout: 10_000 });
    assert.ok(
      result.stderr.includes("pm-loop.mjs"),
      `Expected 'pm-loop.mjs' in stderr. Got: ${result.stderr.slice(0, 300)}`
    );
  });

  it("produces no stdout output", () => {
    const result = spawnSync("node", [CONTINUOUS], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.stdout.trim(), "", `Expected empty stdout. Got: ${result.stdout.slice(0, 200)}`);
  });

  it("mentions continuous-build.mjs in stderr message", () => {
    const result = spawnSync("node", [CONTINUOUS], { encoding: "utf8", timeout: 10_000 });
    assert.ok(
      result.stderr.includes("continuous-build.mjs"),
      `Expected file name in stderr. Got: ${result.stderr.slice(0, 300)}`
    );
  });
});
