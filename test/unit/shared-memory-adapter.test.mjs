/**
 * Unit tests for lib/memory/shared-adapter.mjs
 *
 * Covers:
 *  - CREW_MEMORY_DIR: exported constant
 *  - isSharedMemoryAvailable: returns boolean
 *  - initSharedMemory: creates directory structure
 *  - getAgentKeeper / getAgentMemory / getMemoryBroker: return value or null
 *  - getMemoryStats / getKeeperStats: return value or null
 *
 * Does not test functions that require the CLI memory bundle (may not be built).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = path.join(os.tmpdir(), `crewswarm-shared-mem-test-${process.pid}-${Date.now()}`);

// Set env to redirect shared memory dir
process.env.CREW_MEMORY_DIR = TEST_DIR;

const {
  CREW_MEMORY_DIR,
  isSharedMemoryAvailable,
  initSharedMemory,
  getAgentKeeper,
  getAgentMemory,
  getMemoryBroker,
  getMemoryStats,
  getKeeperStats,
} = await import("../../lib/memory/shared-adapter.mjs");

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("shared-memory-adapter — CREW_MEMORY_DIR", () => {
  it("uses the env var when set", () => {
    assert.equal(CREW_MEMORY_DIR, TEST_DIR);
  });
});

describe("shared-memory-adapter — isSharedMemoryAvailable", () => {
  it("returns a boolean", () => {
    const result = isSharedMemoryAvailable();
    assert.equal(typeof result, "boolean");
  });
});

describe("shared-memory-adapter — initSharedMemory", () => {
  it("creates directory structure and returns ok:true", () => {
    const result = initSharedMemory();
    assert.equal(result.ok, true);
    assert.equal(result.path, TEST_DIR);
    assert.ok(fs.existsSync(TEST_DIR));
    assert.ok(fs.existsSync(path.join(TEST_DIR, ".crew")));
    assert.ok(fs.existsSync(path.join(TEST_DIR, ".crew", "agent-memory")));
  });
});

describe("shared-memory-adapter — factory functions", () => {
  it("getAgentKeeper returns null or an object", () => {
    const keeper = getAgentKeeper(TEST_DIR);
    // May be null if CLI bundle not built
    assert.ok(keeper === null || typeof keeper === "object");
  });

  it("getAgentMemory returns null or an object", () => {
    const memory = getAgentMemory("test-agent");
    assert.ok(memory === null || typeof memory === "object");
  });

  it("getMemoryBroker returns null or an object", () => {
    const broker = getMemoryBroker(TEST_DIR);
    assert.ok(broker === null || typeof broker === "object");
  });

  it("getMemoryStats returns null or an object", () => {
    const stats = getMemoryStats("test-agent");
    assert.ok(stats === null || typeof stats === "object");
  });

  it("getKeeperStats returns null or a promise", async () => {
    const stats = await getKeeperStats(TEST_DIR);
    assert.ok(stats === null || typeof stats === "object");
  });
});
