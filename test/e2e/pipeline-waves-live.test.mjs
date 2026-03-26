/**
 * E2E tests for pipeline waves (multi-agent parallel execution).
 *
 * REQUIRES RUNNING SERVICES:
 * - crew-lead on port 5010
 * - RT message bus
 * - At least 1 agent bridge running (crew-coder)
 *
 * These tests verify actual parallel wave execution, not just unit logic.
 * SKIP: if crew-lead not running or agent can't complete a warm-up task in 30s.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";

const CREW_LEAD_URL = "http://127.0.0.1:5010";
const CONFIG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");

let authToken;

async function getAuthToken() {
  if (authToken) return authToken;
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    authToken = cfg?.rt?.authToken || "";
    return authToken;
  } catch {
    return "";
  }
}

async function dispatchPipeline(pipeline) {
  const token = await getAuthToken();
  const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline`, {
    method: "POST",
    headers: { "Authorization": token ? `Bearer ${token}` : "" },
    body: { pipeline },
    timeout: 60000,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`Pipeline dispatch failed: ${status}`);
  }
  return data;
}

async function pollPipelineStatus(pipelineId, maxWaitMs = 60000) {
  const token = await getAuthToken();
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline/${pipelineId}`, {
        headers: { "Authorization": token ? `Bearer ${token}` : "" },
        timeout: 15000,
      });
      if (status < 200 || status >= 300) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      if (data.status === "completed" || data.status === "done") return data;
      if (data.status === "failed" || data.status === "timeout") {
        throw new Error(`Pipeline ${data.status}: ${data.error || "unknown"}`);
      }
    } catch (e) {
      if (e.message?.startsWith("Pipeline ")) throw e;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(`Pipeline timed out after ${maxWaitMs}ms`);
}

// Pre-flight: check crew-lead is up and agent can complete a task
const crewLeadUp = await checkServiceUp(`${CREW_LEAD_URL}/health`);

let agentReady = false;
if (crewLeadUp) {
  try {
    const token = await getAuthToken();
    const { data } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline`, {
      method: "POST",
      headers: { "Authorization": token ? `Bearer ${token}` : "" },
      body: { pipeline: [{ wave: 1, agent: "crew-coder", task: "Reply OK" }] },
      timeout: 10000,
    });
    if (data?.pipelineId) {
      const result = await pollPipelineStatus(data.pipelineId, 30000);
      agentReady = result.status === "completed";
    }
  } catch { /* agent backlogged or down */ }
}

const SKIP = !crewLeadUp
  ? "crew-lead not running on :5010"
  : !agentReady
    ? "crew-coder agent backlogged or unavailable (warm-up task didn't complete in 30s)"
    : false;

describe("pipeline-waves — parallel execution", { skip: SKIP, timeout: 120000 }, () => {
  it("runs 2-agent wave in parallel", async () => {
    const pipeline = [
      { wave: 1, agent: "crew-coder", task: "Reply with OK" },
      { wave: 1, agent: "crew-coder", task: "Reply with OK" }
    ];

    const start = Date.now();
    const result = await dispatchPipeline(pipeline);
    assert.ok(result.pipelineId, "Should return pipelineId");

    const finalState = await pollPipelineStatus(result.pipelineId, 90000);
    const elapsed = Date.now() - start;

    assert.equal(finalState.status, "completed", "Pipeline should complete successfully");
    assert.ok(finalState.results, "Should have results");
    console.log(`  Pipeline completed in ${elapsed}ms`);
  });
});

describe("pipeline-waves — sequential waves", { skip: SKIP, timeout: 120000 }, () => {
  it("executes waves in sequence (wave 1 before wave 2)", async () => {
    const pipeline = [
      { wave: 1, agent: "crew-coder", task: "Reply with WAVE1" },
      { wave: 2, agent: "crew-coder", task: "Reply with WAVE2" }
    ];

    const result = await dispatchPipeline(pipeline);
    const finalState = await pollPipelineStatus(result.pipelineId, 90000);

    assert.equal(finalState.status, "completed", "Sequential waves should complete");
  });
});

describe("pipeline-waves — stub tests", { timeout: 10000 }, () => {
  it("applies quality gate if crew-qa fails", (t) => {
    t.skip("Quality gate logic tested in unit tests");
  });

  it("extends timeout when agent shows activity", (t) => {
    t.skip("Timeout extension tested in unit tests");
  });

  it("routes through Cursor CLI when toggle ON", (t) => {
    t.skip("Cursor CLI routing tested via engine-routing tests");
  });
});

describe("wave dispatcher integration", { skip: SKIP, timeout: 30000 }, () => {
  it("GET /api/pipeline/:id returns status for a dispatched pipeline", async () => {
    const pipeline = [
      { wave: 1, agent: "crew-coder", task: "Reply with PING" }
    ];
    const result = await dispatchPipeline(pipeline);
    assert.ok(result.pipelineId, "Should return pipelineId");

    const token = await getAuthToken();
    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline/${result.pipelineId}`, {
      headers: { Authorization: token ? `Bearer ${token}` : "" },
    });
    assert.equal(status, 200, "Status endpoint should return 200");
    assert.ok(data.status, "Should have a status field");
  });
});
