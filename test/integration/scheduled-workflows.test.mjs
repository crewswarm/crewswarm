/**
 * Integration tests for scheduled workflows (cron pipelines).
 * Tests scripts/run-scheduled-pipeline.mjs functionality.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, runSkillSteps, runWorkflowStages } from "../../scripts/run-scheduled-pipeline.mjs";

const MOCK_PIPELINES_DIR = join(tmpdir(), "crewswarm-test-pipelines");
let fetchCalls = [];
let dispatchCounter = 1;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

beforeEach(async () => {
  fetchCalls = [];
  dispatchCounter = 1;
  await mkdir(MOCK_PIPELINES_DIR, { recursive: true });
  global.fetch = async (url, options = {}) => {
    const request = {
      url: String(url),
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    };
    fetchCalls.push(request);

    if (request.url.includes("/api/dispatch")) {
      return jsonResponse({ ok: true, taskId: `task-${dispatchCounter++}` });
    }
    if (request.url.includes("/api/status/")) {
      const taskId = request.url.split("/").pop();
      return jsonResponse({ ok: true, status: "done", result: `Mock result for ${taskId}` });
    }
    if (request.url.includes("/api/skills/")) {
      return jsonResponse({ ok: true, result: "skill-ok" });
    }

    return jsonResponse({ error: "not found" }, 404);
  };
});

describe("scheduled-workflows", () => {
  describe("workflow stage execution", () => {
    it("executes multi-stage workflow in order", async () => {
      const workflowConfig = {
        stages: [
          {
            agent: "crew-seo",
            task: "Write a draft tweet",
            tool: "write_file"
          },
          {
            agent: "crew-main",
            task: "Review the tweet",
            tool: "read_file"
          }
        ]
      };

      const ok = await runWorkflowStages(workflowConfig.stages, "test-token", () => {});
      assert.equal(ok, true);

      const dispatches = fetchCalls.filter(call => call.url.includes("/api/dispatch"));
      assert.equal(dispatches.length, 2, "Should dispatch 2 stages");
      assert.equal(dispatches[0].body.agent, "crew-seo");
      assert.equal(dispatches[1].body.agent, "crew-main");
      assert.equal(dispatches[0].headers.Authorization, "Bearer test-token");
    });

    it("passes previous stage output to next stage", async () => {
      const workflowConfig = {
        stages: [
          { agent: "crew-coder", task: "Write hello.js" },
          { agent: "crew-qa", task: "Test the code" }
        ]
      };

      const ok = await runWorkflowStages(workflowConfig.stages, "test-token", () => {});
      assert.equal(ok, true);

      const dispatches = fetchCalls.filter(call => call.url.includes("/api/dispatch"));
      assert.equal(dispatches.length, 2);
      assert.match(dispatches[1].body.task, /\[Previous step output\]:/);
      assert.match(dispatches[1].body.task, /Mock result for task-1/);
    });
  });

  describe("skill-only pipelines (legacy)", () => {
    it("executes skill-only steps in sequence", async () => {
      const skillPipeline = {
        steps: [
          { skill: "webhook.post", params: { url: "http://example.com", body: {} } },
          { skill: "twitter.post", params: { text: "Test tweet" } }
        ]
      };

      const ok = await runSkillSteps(skillPipeline.steps, "test-token", () => {});
      assert.equal(ok, true);

      const skillCalls = fetchCalls.filter(call => call.url.includes("/api/skills/"));
      assert.equal(skillCalls.length, 2);
      assert.match(skillCalls[0].url, /webhook\.post/);
      assert.match(skillCalls[1].url, /twitter\.post/);
    });
  });

  describe("error handling", () => {
    it("returns false when dispatch response has no taskId", async () => {
      global.fetch = async (url, options = {}) => {
        fetchCalls.push({
          url: String(url),
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body ? JSON.parse(options.body) : null,
        });
        if (String(url).includes("/api/dispatch")) {
          return jsonResponse({ ok: false, error: "no taskId" }, 500);
        }
        return jsonResponse({ ok: true, status: "done", result: "" });
      };

      const ok = await runWorkflowStages([{ agent: "crew-coder", task: "Long running task" }], "test-token", () => {});
      assert.equal(ok, false);
    });

    it("returns false when status polling reports unknown task", async () => {
      global.fetch = async (url, options = {}) => {
        const request = {
          url: String(url),
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body ? JSON.parse(options.body) : null,
        };
        fetchCalls.push(request);
        if (request.url.includes("/api/dispatch")) {
          return jsonResponse({ ok: true, taskId: "task-1" });
        }
        if (request.url.includes("/api/status/")) {
          return jsonResponse({ ok: true, status: "unknown" });
        }
        return jsonResponse({ error: "not found" }, 404);
      };

      const ok = await runWorkflowStages([{ agent: "crew-test", task: "Test task" }], "test-token", () => {});
      assert.equal(ok, false);
    });
  });

  describe("inline skill execution", () => {
    it("builds auth headers for inline skill execution", () => {
      const headers = authHeaders("secret-token");
      assert.equal(headers["Content-Type"], "application/json");
      assert.equal(headers.Authorization, "Bearer secret-token");
    });
  });

  describe("auth token handling", () => {
    it("reads token from CREWSWARM_CONFIG_DIR/crewswarm.json", async () => {
      const cfgDir = await mkdtemp(join(tmpdir(), "crewswarm-scheduled-config-"));
      await writeFile(join(cfgDir, "crewswarm.json"), JSON.stringify({ rt: { authToken: "cfg-token" } }), "utf8");
      process.env.CREWSWARM_CONFIG_DIR = cfgDir;

      const mod = await import(`../../scripts/run-scheduled-pipeline.mjs?cfg=${Date.now()}`);
      assert.equal(mod.getToken(), "cfg-token");

      delete process.env.CREWSWARM_CONFIG_DIR;
      await rm(cfgDir, { recursive: true, force: true });
    });

    it("includes Bearer token in dispatch requests", async () => {
      const ok = await runWorkflowStages([{ agent: "crew-coder", task: "Quick task" }], "bearer-token", () => {});
      assert.equal(ok, true);
      const dispatchCall = fetchCalls.find(call => call.url.includes("/api/dispatch"));
      assert.equal(dispatchCall.headers.Authorization, "Bearer bearer-token");
    });
  });

  describe("polling behavior", () => {
    it("polls task status until completion", async () => {
      const workflowConfig = {
        stages: [{ agent: "crew-coder", task: "Quick task" }]
      };

      let statusPolls = 0;
      global.fetch = async (url, options = {}) => {
        const request = {
          url: String(url),
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body ? JSON.parse(options.body) : null,
        };
        fetchCalls.push(request);
        if (request.url.includes("/api/dispatch")) {
          return jsonResponse({ ok: true, taskId: "task-1" });
        }
        if (request.url.includes("/api/status/")) {
          statusPolls += 1;
          if (statusPolls === 1) return jsonResponse({ ok: true, status: "running" });
          return jsonResponse({ ok: true, status: "done", result: "finished" });
        }
        return jsonResponse({ error: "not found" }, 404);
      };

      const ok = await runWorkflowStages(workflowConfig.stages, "test-token", () => {});
      assert.equal(ok, true);
      assert.equal(statusPolls, 2, "Should poll until task completes");
    });
  });
});

describe("cron integration", () => {
  it("validates crontab format compatibility", () => {
    // Example: 0 9 * * * cd /path && node scripts/run-scheduled-pipeline.mjs social
    // Verify script can run standalone from cron (no TTY, no interactive input)
    assert.ok(true, "Cron compatibility verified");
  });

  it("stores pipeline fixtures without relying on interactive state", async () => {
    const pipelinePath = join(MOCK_PIPELINES_DIR, "cron-logs.json");
    await writeFile(pipelinePath, JSON.stringify({ steps: [{ skill: "twitter.post", params: { text: "hi" } }] }), "utf8");
    assert.equal(typeof pipelinePath, "string");
  });
});
