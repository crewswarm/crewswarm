/**
 * E2E tests for multi-engine dispatch — verify all 6 CLI engines can execute tasks.
 *
 * REQUIRES RUNNING SERVICES:
 * - crew-lead on port 5010
 * - All engines installed (claude, agent/cursor, gemini, codex, opencode, crew-cli)
 *
 * Tests:
 *   1. Dispatch to each engine individually and verify response
 *   2. Parallel wave with mixed engines
 *   3. Session resume works across messages
 *
 * SKIP: if crew-lead not running or specific engine not installed.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
  } catch { return ""; }
}

function isInstalled(bin) {
  try {
    execSync(`which ${bin}`, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch { return false; }
}

async function dispatch(agent, task, engineFlags = {}) {
  const token = await getAuthToken();
  const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/dispatch`, {
    method: "POST",
    headers: { "Authorization": token ? `Bearer ${token}` : "" },
    body: { agent, task, ...engineFlags },
    timeout: 15000,
  });
  if (status < 200 || status >= 300) throw new Error(`Dispatch failed: ${status}`);
  return data;
}

async function pollTaskStatus(taskId, maxWaitMs = 90000) {
  const token = await getAuthToken();
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const { data } = await httpRequest(`${CREW_LEAD_URL}/api/status/${taskId}`, {
        headers: { "Authorization": token ? `Bearer ${token}` : "" },
        timeout: 10000,
      });
      if (data.status === "done" || data.status === "completed") return data;
      if (data.status === "failed" || data.status === "timeout") {
        throw new Error(`Task ${data.status}: ${data.error || data.result || "unknown"}`);
      }
    } catch (e) {
      if (e.message?.startsWith("Task ")) throw e;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Task timed out after ${maxWaitMs}ms`);
}

async function dispatchAndWait(agent, task, engineFlags = {}, maxWaitMs = 90000) {
  const result = await dispatch(agent, task, engineFlags);
  const taskId = result.taskId || result.id;
  if (!taskId) throw new Error("No taskId returned from dispatch");
  return pollTaskStatus(taskId, maxWaitMs);
}

// Pre-flight checks
const crewLeadUp = await checkServiceUp(`${CREW_LEAD_URL}/health`);
const SKIP = crewLeadUp ? false : "crew-lead not running on :5010";

// Check which engines are installed
const engines = {
  claude: isInstalled("claude"),
  cursor: isInstalled("agent"),
  gemini: isInstalled("gemini"),
  codex: isInstalled("codex"),
  opencode: isInstalled("opencode"),
};

// ─── Individual engine dispatch tests ────────────────────────────────────────

describe("multi-engine dispatch — Claude Code", {
  skip: SKIP || !engines.claude ? "Claude Code CLI not installed" : false,
  timeout: 120000
}, () => {
  it("dispatches task via Claude Code and gets response", async () => {
    const result = await dispatchAndWait("crew-coder", "Reply with exactly: CLAUDE_ENGINE_OK", {
      useClaudeCode: true,
    });
    assert.equal(result.status, "done", "Task should complete");
    assert.ok(result.result, "Should have a result");
    console.log(`    Claude Code: ${(result.result || "").slice(0, 80)}`);
  });
});

describe("multi-engine dispatch — Cursor CLI", {
  skip: SKIP || !engines.cursor ? "Cursor CLI not installed" : false,
  timeout: 120000
}, () => {
  it("dispatches task via Cursor CLI and gets response", async () => {
    const result = await dispatchAndWait("crew-coder", "Reply with exactly: CURSOR_ENGINE_OK", {
      useCursorCli: true,
    });
    assert.equal(result.status, "done", "Task should complete");
    assert.ok(result.result, "Should have a result");
    console.log(`    Cursor CLI: ${(result.result || "").slice(0, 80)}`);
  });
});

describe("multi-engine dispatch — Gemini CLI", {
  skip: SKIP || !engines.gemini ? "Gemini CLI not installed" : false,
  timeout: 120000
}, () => {
  it("dispatches task via Gemini CLI and gets response", async () => {
    const result = await dispatchAndWait("crew-coder", "Reply with exactly: GEMINI_ENGINE_OK", {
      useGeminiCli: true,
    });
    assert.equal(result.status, "done", "Task should complete");
    assert.ok(result.result, "Should have a result");
    console.log(`    Gemini CLI: ${(result.result || "").slice(0, 80)}`);
  });
});

describe("multi-engine dispatch — Codex CLI", {
  skip: SKIP || !engines.codex ? "Codex CLI not installed" : false,
  timeout: 120000
}, () => {
  it("dispatches task via Codex CLI and gets response", async () => {
    const result = await dispatchAndWait("crew-coder", "Reply with exactly: CODEX_ENGINE_OK", {
      useCodex: true,
    });
    assert.equal(result.status, "done", "Task should complete");
    assert.ok(result.result, "Should have a result");
    console.log(`    Codex CLI: ${(result.result || "").slice(0, 80)}`);
  });
});

describe("multi-engine dispatch — OpenCode", {
  skip: SKIP || !engines.opencode ? "OpenCode CLI not installed" : false,
  timeout: 120000
}, () => {
  it("dispatches task via OpenCode and gets response", async () => {
    const result = await dispatchAndWait("crew-coder", "Reply with exactly: OPENCODE_ENGINE_OK", {
      useOpenCode: true,
    });
    assert.equal(result.status, "done", "Task should complete");
    assert.ok(result.result, "Should have a result");
    console.log(`    OpenCode: ${(result.result || "").slice(0, 80)}`);
  });
});

describe("multi-engine dispatch — LLM Direct (no CLI engine)", {
  skip: SKIP,
  timeout: 60000
}, () => {
  it("dispatches task via direct LLM agent and gets response", async () => {
    // crew-github uses llm-direct (no CLI engine flag set)
    const result = await dispatchAndWait("crew-github", "Reply with exactly: LLM_DIRECT_OK");
    assert.equal(result.status, "done", "Task should complete");
    assert.ok(result.result, "Should have a result");
    console.log(`    LLM Direct: ${(result.result || "").slice(0, 80)}`);
  });
});

// ─── Mixed-engine wave test ─────────────────────────────────────────────────

describe("multi-engine wave — mixed engines in parallel", {
  skip: SKIP || (!engines.claude && !engines.gemini) ? "Need at least Claude + Gemini for mixed wave" : false,
  timeout: 180000
}, () => {
  it("runs a 2-agent wave with different engines", async () => {
    const token = await getAuthToken();
    const pipeline = [
      { wave: 1, agent: "crew-coder", task: "Reply with WAVE_CLAUDE", useClaudeCode: true },
      { wave: 1, agent: "crew-seo", task: "Reply with WAVE_GEMINI", useGeminiCli: true },
    ];

    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline`, {
      method: "POST",
      headers: { "Authorization": token ? `Bearer ${token}` : "" },
      body: { pipeline },
      timeout: 15000,
    });
    assert.ok(status >= 200 && status < 300, `Pipeline dispatch failed: ${status}`);
    assert.ok(data.pipelineId, "Should return pipelineId");

    // Poll for completion
    const start = Date.now();
    let finalState;
    while (Date.now() - start < 150000) {
      const { data: state } = await httpRequest(`${CREW_LEAD_URL}/api/pipeline/${data.pipelineId}`, {
        headers: { "Authorization": token ? `Bearer ${token}` : "" },
      });
      if (state.status === "completed" || state.status === "done") {
        finalState = state;
        break;
      }
      if (state.status === "failed") throw new Error("Pipeline failed");
      await new Promise(r => setTimeout(r, 3000));
    }
    assert.ok(finalState, "Pipeline should complete within 150s");
    console.log(`    Mixed wave completed in ${Date.now() - start}ms`);
  });
});
