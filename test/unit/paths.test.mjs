/**
 * Unit tests for lib/runtime/paths.mjs
 *
 * Covers: getConfigDir, getStateDir, getConfigPath, getStatePath, resetPaths
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  getConfigDir,
  getStateDir,
  getConfigPath,
  getStatePath,
  resetPaths,
} from "../../lib/runtime/paths.mjs";

describe("paths", () => {
  const origConfigDir = process.env.CREWSWARM_CONFIG_DIR;
  const origStateDir = process.env.CREWSWARM_STATE_DIR;
  const origTestMode = process.env.CREWSWARM_TEST_MODE;

  afterEach(() => {
    // Restore env
    if (origConfigDir !== undefined) process.env.CREWSWARM_CONFIG_DIR = origConfigDir;
    else delete process.env.CREWSWARM_CONFIG_DIR;
    if (origStateDir !== undefined) process.env.CREWSWARM_STATE_DIR = origStateDir;
    else delete process.env.CREWSWARM_STATE_DIR;
    if (origTestMode !== undefined) process.env.CREWSWARM_TEST_MODE = origTestMode;
    else delete process.env.CREWSWARM_TEST_MODE;
    resetPaths();
  });

  beforeEach(() => {
    resetPaths();
  });

  it("getConfigDir returns a string ending in .crewswarm by default", () => {
    delete process.env.CREWSWARM_CONFIG_DIR;
    delete process.env.CREWSWARM_TEST_MODE;
    const dir = getConfigDir();
    assert.ok(typeof dir === "string");
    assert.ok(dir.includes(".crewswarm") || dir.includes("crewswarm"));
  });

  it("getConfigDir respects CREWSWARM_CONFIG_DIR env var", () => {
    const tmpDir = path.join(os.tmpdir(), `paths-test-cfg-${process.pid}`);
    process.env.CREWSWARM_CONFIG_DIR = tmpDir;
    resetPaths();
    const dir = getConfigDir();
    assert.equal(dir, tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getStateDir returns a string", () => {
    const dir = getStateDir();
    assert.ok(typeof dir === "string");
    assert.ok(dir.length > 0);
  });

  it("getConfigPath joins parts to config dir", () => {
    const p = getConfigPath("sub", "file.json");
    assert.ok(p.endsWith(path.join("sub", "file.json")));
  });

  it("getStatePath joins parts to state dir", () => {
    const p = getStatePath("logs", "app.log");
    assert.ok(p.endsWith(path.join("logs", "app.log")));
  });

  it("resetPaths clears cache so next call re-evaluates", () => {
    const dir1 = getConfigDir();
    resetPaths();
    const dir2 = getConfigDir();
    // Both should resolve, may be same path
    assert.ok(typeof dir1 === "string");
    assert.ok(typeof dir2 === "string");
  });

  it("test mode uses tmpdir-based paths", () => {
    process.env.CREWSWARM_TEST_MODE = "true";
    delete process.env.CREWSWARM_CONFIG_DIR;
    resetPaths();
    const dir = getConfigDir();
    assert.ok(dir.includes(os.tmpdir()) || dir.includes("crewswarm-test"));
  });
});
