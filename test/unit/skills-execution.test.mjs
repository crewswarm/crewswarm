/**
 * Unit tests for skill resolution and execution logic (extracted from crew-lead.mjs).
 * Inlined algorithm — no import of crew-lead.mjs (side effects on import).
 * Uses temp directories, no external network calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Inlined logic from crew-lead.mjs (configurable skillsDir) ─────────────────

function resolveSkillAlias(skillName, skillsDir) {
  const exact = path.join(skillsDir, `${skillName}.json`);
  if (fs.existsSync(exact)) return skillName;
  try {
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const real = f.replace(".json", "");
      const def = JSON.parse(fs.readFileSync(path.join(skillsDir, f), "utf8"));
      const aliases = def.aliases || [];
      if (aliases.includes(skillName)) return real;
    }
  } catch {}
  return skillName;
}

function buildMergedParams(skillDef, params) {
  const merged = { ...(skillDef.defaultParams || {}), ...params };
  const aliases = skillDef.paramAliases || {};
  for (const [param, map] of Object.entries(aliases)) {
    if (merged[param] != null && map[merged[param]] != null) merged[param] = map[merged[param]];
  }
  return merged;
}

function buildSkillUrl(skillDef, merged) {
  const urlParam = (skillDef.url || "").match(/\{(\w+)\}/);
  const emptyKey = urlParam ? urlParam[1] : null;
  const paramEmpty =
    emptyKey &&
    (merged[emptyKey] === undefined ||
      merged[emptyKey] === null ||
      String(merged[emptyKey] || "").trim() === "");
  if (skillDef.listUrl && paramEmpty) {
    return skillDef.listUrl;
  }
  let urlStr = skillDef.url || "";
  for (const [k, v] of Object.entries(merged)) {
    urlStr = urlStr.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  return urlStr;
}

function validateCmdAllowedValues(skillDef, merged) {
  if (skillDef.type !== "cmd") return;
  const allowed = skillDef.allowedValues || {};
  for (const [key, whitelist] of Object.entries(allowed)) {
    if (merged[key] !== undefined && !whitelist.includes(String(merged[key]))) {
      throw new Error(
        `Skill: invalid value for "${key}": ${merged[key]}. Allowed: ${whitelist.join(", ")}`
      );
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("skills execution — inlined logic", () => {
  let tmpDir;

  function setupTmpDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-skills-test-"));
    return tmpDir;
  }

  function writeSkill(name, def) {
    const file = path.join(tmpDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(def, null, 2), "utf8");
  }

  function teardown() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  }

  describe("resolveSkillAlias", () => {
    it("alias resolution: skill with aliases → resolveSkillAlias(alias) returns real name", () => {
      setupTmpDir();
      try {
        writeSkill("zeroeval.benchmark", {
          aliases: ["bench", "benchmarks"],
          url: "https://api.zeroeval.com/leaderboard/benchmarks/{benchmark_id}",
          method: "GET",
        });
        assert.equal(resolveSkillAlias("bench", tmpDir), "zeroeval.benchmark");
        assert.equal(resolveSkillAlias("benchmarks", tmpDir), "zeroeval.benchmark");
      } finally {
        teardown();
      }
    });

    it("exact match: resolveSkillAlias(exact) returns exact when file exists", () => {
      setupTmpDir();
      try {
        writeSkill("zeroeval.benchmark", { url: "https://example.com/{id}", method: "GET" });
        assert.equal(resolveSkillAlias("zeroeval.benchmark", tmpDir), "zeroeval.benchmark");
      } finally {
        teardown();
      }
    });

    it("unknown skill: resolveSkillAlias(nonexistent) returns passthrough", () => {
      setupTmpDir();
      try {
        writeSkill("known.skill", { url: "https://example.com", method: "GET" });
        assert.equal(resolveSkillAlias("nonexistent", tmpDir), "nonexistent");
      } finally {
        teardown();
      }
    });
  });

  describe("paramAliases normalization", () => {
    it("paramAliases normalizes merged params", () => {
      const skillDef = {
        defaultParams: { benchmark_id: "swe-bench-verified" },
        paramAliases: { benchmark_id: { "human-eval": "humaneval", list: "" } },
      };
      const params = { benchmark_id: "human-eval" };
      const merged = buildMergedParams(skillDef, params);
      assert.equal(merged.benchmark_id, "humaneval");
    });
  });

  describe("listUrl fallback", () => {
    it("when param is empty and skillDef.listUrl is set, URL becomes listUrl", () => {
      const skillDef = {
        url: "https://api.example.com/items/{benchmark_id}",
        listUrl: "https://api.example.com/items",
      };
      const merged = { benchmark_id: "" };
      const url = buildSkillUrl(skillDef, merged);
      assert.equal(url, "https://api.example.com/items");
    });

    it("when param is undefined, listUrl is used", () => {
      const skillDef = {
        url: "https://api.example.com/items/{benchmark_id}",
        listUrl: "https://api.example.com/items",
      };
      const merged = {};
      const url = buildSkillUrl(skillDef, merged);
      assert.equal(url, "https://api.example.com/items");
    });
  });

  describe("URL interpolation", () => {
    it("{benchmark_id} in URL gets replaced with merged param value", () => {
      const skillDef = {
        url: "https://api.zeroeval.com/leaderboard/benchmarks/{benchmark_id}",
      };
      const merged = { benchmark_id: "swe-bench-verified" };
      const url = buildSkillUrl(skillDef, merged);
      assert.equal(url, "https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified");
    });
  });

  describe("allowedValues validation (cmd-type skills)", () => {
    it("value not in whitelist throws error", () => {
      const skillDef = {
        type: "cmd",
        cmd: "echo ok",
        allowedValues: { action: ["deploy", "rollback"] },
      };
      const merged = { action: "delete" };
      assert.throws(
        () => validateCmdAllowedValues(skillDef, merged),
        /invalid value for "action": delete/
      );
    });

    it("value in whitelist does not throw", () => {
      const skillDef = {
        type: "cmd",
        cmd: "echo ok",
        allowedValues: { action: ["deploy", "rollback"] },
      };
      const merged = { action: "deploy" };
      assert.doesNotThrow(() => validateCmdAllowedValues(skillDef, merged));
    });
  });
});
