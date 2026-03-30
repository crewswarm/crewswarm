/**
 * Unit tests for lib/skills/index.mjs
 *
 * Covers:
 *  - initSkills: dependency injection
 *  - resolveSkillAlias: alias resolution
 *  - loadSkillDef: skill definition loading
 *  - loadPendingSkills / savePendingSkills: round-trip
 *  - executeSkill: SKILL.md instruction cards (no network)
 *
 * Skips: notifyTelegramSkillApproval (network), executeSkill with URL (network)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const {
  initSkills,
  resolveSkillAlias,
  loadSkillDef,
  loadPendingSkills,
  savePendingSkills,
  executeSkill,
} = await import("../../lib/skills/index.mjs");

const SKILLS_DIR = path.join(os.homedir(), ".crewswarm", "skills");
const TEST_SKILL_DIR = path.join(SKILLS_DIR, "test-skill-unit");
const TEST_SKILL_JSON = path.join(SKILLS_DIR, "test-skill-json-unit.json");
const PENDING_FILE = path.join(os.homedir(), ".crewswarm", "pending-skills.json");

let pendingBackup = null;

before(() => {
  // Backup pending skills
  try {
    pendingBackup = fs.readFileSync(PENDING_FILE, "utf8");
  } catch {}

  // Create test SKILL.md
  fs.mkdirSync(TEST_SKILL_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_SKILL_DIR, "SKILL.md"),
    `---
name: test-skill-unit
description: A test skill for unit testing
aliases: ['test-alias-unit']
---
This is the skill body content for testing.
`,
    "utf8"
  );

  // Create test JSON skill
  fs.writeFileSync(
    TEST_SKILL_JSON,
    JSON.stringify({
      name: "test-skill-json-unit",
      description: "JSON test skill",
      aliases: ["json-alias-unit"],
      url: "https://example.com/api",
      method: "POST",
      defaultParams: { query: "default" },
    }),
    "utf8"
  );
});

after(() => {
  // Cleanup test files
  fs.rmSync(TEST_SKILL_DIR, { recursive: true, force: true });
  try {
    fs.unlinkSync(TEST_SKILL_JSON);
  } catch {}
  // Restore pending skills
  if (pendingBackup !== null) {
    fs.writeFileSync(PENDING_FILE, pendingBackup, "utf8");
  }
});

// ── initSkills ──────────────────────────────────────────────────────────────

describe("skills — initSkills", () => {
  it("accepts dependency injection without throwing", () => {
    initSkills({
      resolveConfig: () => ({}),
      resolveTelegramBridgeConfig: () => ({}),
    });
  });

  it("handles empty options", () => {
    initSkills({});
  });
});

// ── resolveSkillAlias ───────────────────────────────────────────────────────

describe("skills — resolveSkillAlias", () => {
  it("resolves exact JSON skill name", () => {
    const resolved = resolveSkillAlias("test-skill-json-unit");
    assert.equal(resolved, "test-skill-json-unit");
  });

  it("resolves JSON skill alias", () => {
    const resolved = resolveSkillAlias("json-alias-unit");
    assert.equal(resolved, "test-skill-json-unit");
  });

  it("returns original name for unknown skill", () => {
    const resolved = resolveSkillAlias("nonexistent-skill-xyz");
    assert.equal(resolved, "nonexistent-skill-xyz");
  });
});

// ── loadSkillDef ────────────────────────────────────────────────────────────

describe("skills — loadSkillDef", () => {
  it("loads a JSON skill definition", () => {
    const def = loadSkillDef("test-skill-json-unit");
    assert.ok(def);
    assert.equal(def.name, "test-skill-json-unit");
    assert.equal(def.method, "POST");
  });

  it("loads a SKILL.md skill definition", () => {
    const def = loadSkillDef("test-skill-unit");
    assert.ok(def);
    assert.equal(def._type, "skill-md");
    assert.equal(def.name, "test-skill-unit");
    assert.ok(def._body.includes("skill body content"));
  });

  it("returns null for nonexistent skill", () => {
    const def = loadSkillDef("nonexistent-skill-xyz-123");
    assert.equal(def, null);
  });
});

// ── loadPendingSkills / savePendingSkills ────────────────────────────────────

describe("skills — pending skills", () => {
  it("savePendingSkills + loadPendingSkills round-trips", () => {
    const data = { "skill-1": { status: "pending", ts: Date.now() } };
    savePendingSkills(data);
    const loaded = loadPendingSkills();
    assert.equal(loaded["skill-1"].status, "pending");
  });

  it("loadPendingSkills returns empty object when file missing", () => {
    try {
      fs.unlinkSync(PENDING_FILE);
    } catch {}
    const loaded = loadPendingSkills();
    assert.deepEqual(loaded, {});
  });
});

// ── executeSkill (SKILL.md only, no network) ────────────────────────────────

describe("skills — executeSkill (instruction card)", () => {
  it("returns skill body for SKILL.md without URL", async () => {
    const def = loadSkillDef("test-skill-unit");
    const result = await executeSkill(def, {});
    assert.ok(typeof result === "string");
    assert.ok(result.includes("[Skill: test-skill-unit]"));
    assert.ok(result.includes("skill body content"));
  });

  it("includes params in output when provided", async () => {
    const def = loadSkillDef("test-skill-unit");
    const result = await executeSkill(def, { foo: "bar" });
    assert.ok(result.includes("foo"));
    assert.ok(result.includes("bar"));
  });
});
