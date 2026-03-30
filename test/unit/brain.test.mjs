/**
 * Unit tests for lib/crew-lead/brain.mjs
 *
 * Covers: initBrain, appendToBrain, readGlobalRules, writeGlobalRules,
 *         appendGlobalRule, getWorkspaceRoot, searchCodebase
 *
 * Skips: searchWithBrave (network call)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initBrain,
  appendToBrain,
  readGlobalRules,
  writeGlobalRules,
  appendGlobalRule,
  getWorkspaceRoot,
  searchCodebase,
} from "../../lib/crew-lead/brain.mjs";

const tmpDir = path.join(os.tmpdir(), `brain-test-${process.pid}-${Date.now()}`);
const brainPath = path.join(tmpDir, "brain.md");
const rulesPath = path.join(tmpDir, "global-rules.md");

describe("brain", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    initBrain({ brainPath, globalRulesPath: rulesPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appendToBrain writes a dated entry to the brain file", () => {
    const result = appendToBrain("crew-coder", "found a bug in auth");
    assert.ok(result.includes("crew-coder"));
    assert.ok(result.includes("found a bug in auth"));
    const content = fs.readFileSync(brainPath, "utf8");
    assert.ok(content.includes("crew-coder"));
  });

  it("appendToBrain to a projectDir creates a .crewswarm/brain.md", () => {
    const projectDir = path.join(tmpDir, "myproject");
    fs.mkdirSync(projectDir, { recursive: true });
    appendToBrain("crew-qa", "tests pass", projectDir);
    const projectBrain = path.join(projectDir, ".crewswarm", "brain.md");
    assert.ok(fs.existsSync(projectBrain));
    const content = fs.readFileSync(projectBrain, "utf8");
    assert.ok(content.includes("crew-qa"));
  });

  it("readGlobalRules returns empty string when no rules file", () => {
    assert.equal(readGlobalRules(), "");
  });

  it("writeGlobalRules then readGlobalRules round-trips", () => {
    writeGlobalRules("rule one\nrule two");
    assert.equal(readGlobalRules(), "rule one\nrule two");
  });

  it("appendGlobalRule appends a bullet to existing rules", () => {
    writeGlobalRules("# Global Agent Rules\n\n- existing rule");
    const result = appendGlobalRule("new rule");
    assert.ok(result.includes("- existing rule"));
    assert.ok(result.includes("- new rule"));
  });

  it("appendGlobalRule creates header when no rules exist", () => {
    const result = appendGlobalRule("first rule");
    assert.ok(result.includes("# Global Agent Rules"));
    assert.ok(result.includes("- first rule"));
  });
});

describe("brain – getWorkspaceRoot", () => {
  it("returns process.cwd() by default", () => {
    const prev = process.env.CREW_LEAD_WORKSPACE;
    delete process.env.CREW_LEAD_WORKSPACE;
    assert.equal(getWorkspaceRoot(), process.cwd());
    if (prev !== undefined) process.env.CREW_LEAD_WORKSPACE = prev;
  });
});

describe("brain – searchCodebase", () => {
  it("returns null for empty query", () => {
    assert.equal(searchCodebase(""), null);
  });

  it("returns null for single-char query", () => {
    assert.equal(searchCodebase("x"), null);
  });
});
