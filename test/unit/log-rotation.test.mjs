/**
 * Unit tests for lib/runtime/log-rotation.mjs
 *
 * Covers: appendWithRotation, appendWithRotationSync, forceRotate
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  appendWithRotation,
  appendWithRotationSync,
  forceRotate,
} from "../../lib/runtime/log-rotation.mjs";

const tmpDir = path.join(os.tmpdir(), `logrot-test-${process.pid}-${Date.now()}`);
const logFile = path.join(tmpDir, "test.jsonl");

describe("log-rotation", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appendWithRotation creates a new file and writes content", async () => {
    await appendWithRotation(logFile, "line1\n");
    assert.ok(fs.existsSync(logFile));
    assert.equal(fs.readFileSync(logFile, "utf8"), "line1\n");
  });

  it("appendWithRotation appends to existing file", async () => {
    await appendWithRotation(logFile, "line1\n");
    await appendWithRotation(logFile, "line2\n");
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("line1"));
    assert.ok(content.includes("line2"));
  });

  it("appendWithRotationSync creates and appends", () => {
    appendWithRotationSync(logFile, "sync-line\n");
    assert.ok(fs.existsSync(logFile));
    assert.ok(fs.readFileSync(logFile, "utf8").includes("sync-line"));
  });

  it("forceRotate moves file to .1", () => {
    fs.writeFileSync(logFile, "old data\n");
    forceRotate(logFile);
    assert.ok(!fs.existsSync(logFile), "original should be gone");
    assert.ok(fs.existsSync(`${logFile}.1`), ".1 should exist");
    assert.equal(fs.readFileSync(`${logFile}.1`, "utf8"), "old data\n");
  });

  it("forceRotate is a no-op when file does not exist", () => {
    assert.doesNotThrow(() => forceRotate(path.join(tmpDir, "nonexistent.log")));
  });

  it("forceRotate shifts existing rotations", () => {
    fs.writeFileSync(logFile, "current\n");
    fs.writeFileSync(`${logFile}.1`, "prev1\n");
    forceRotate(logFile);
    assert.ok(fs.existsSync(`${logFile}.1`));
    assert.ok(fs.existsSync(`${logFile}.2`));
    assert.equal(fs.readFileSync(`${logFile}.1`, "utf8"), "current\n");
    assert.equal(fs.readFileSync(`${logFile}.2`, "utf8"), "prev1\n");
  });
});
