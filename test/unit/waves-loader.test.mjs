/**
 * Unit tests for lib/crew-lead/waves-loader.mjs
 *
 * Covers: loadWavesConfig, buildPlanningPipeline, formatWavesForPrompt,
 *         generatePipelineJson
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadWavesConfig,
  buildPlanningPipeline,
  formatWavesForPrompt,
  generatePipelineJson,
} from "../../lib/crew-lead/waves-loader.mjs";

describe("waves-loader – loadWavesConfig", () => {
  it("returns an object or null", () => {
    const config = loadWavesConfig();
    assert.ok(config === null || typeof config === "object");
  });

  it("if config exists, has waves array", () => {
    const config = loadWavesConfig();
    if (config) {
      assert.ok(Array.isArray(config.waves));
    }
  });
});

describe("waves-loader – buildPlanningPipeline", () => {
  it("returns an array or null", () => {
    const steps = buildPlanningPipeline({});
    assert.ok(steps === null || Array.isArray(steps));
  });

  it("substitutes template variables when config exists", () => {
    const steps = buildPlanningPipeline({
      projectName: "TestApp",
      projectPath: "/tmp/test",
      userBrief: "build a dashboard",
      userRequest: "create dashboard",
    });
    if (steps && steps.length > 0) {
      const allTasks = steps.map((s) => s.task).join(" ");
      // Template vars should be replaced
      assert.ok(!allTasks.includes("{{projectName}}"), "projectName not substituted");
    }
  });

  it("each step has wave, agent, and task fields", () => {
    const steps = buildPlanningPipeline({});
    if (steps) {
      for (const step of steps) {
        assert.ok("wave" in step);
        assert.ok("agent" in step);
        assert.ok("task" in step);
      }
    }
  });
});

describe("waves-loader – formatWavesForPrompt", () => {
  it("returns a string", () => {
    const result = formatWavesForPrompt();
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });
});

describe("waves-loader – generatePipelineJson", () => {
  it("returns a JSON string or null", () => {
    const result = generatePipelineJson({ projectName: "X" });
    if (result !== null) {
      assert.ok(typeof result === "string");
      // Should be valid JSON
      const parsed = JSON.parse(result);
      assert.ok(Array.isArray(parsed));
    }
  });
});
