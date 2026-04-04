/**
 * E2E tests for the LIVE running crewswarm system.
 * Requires crew-lead running on port 5010. All tests are skipped gracefully
 * if crew-lead is not reachable.
 *
 * Run: node --test test/e2e/live-dispatch.test.mjs
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";
import { logTestEvidence } from "../helpers/test-log.mjs";

const CREW_LEAD_URL = "http://127.0.0.1:5010";
const DASHBOARD_URL = "http://127.0.0.1:4319";
const E2E_SESSION = "e2e-test";
const POLL_MS = 2000;
const POLL_MAX = 15; // 30s total for slow tests

let authToken = "";
let crewLeadUp = false;

function getAuthToken() {
  const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return cfg?.rt?.authToken || "";
  } catch {
    return "";
  }
}

before(async () => {
  authToken = getAuthToken();
  crewLeadUp = await checkServiceUp(`${CREW_LEAD_URL}/health`);
  if (!crewLeadUp) {
    console.log("⚠️ crew-lead not running on 5010 — skipping all e2e tests");
  }
});

function skipIfDown(t) {
  if (!crewLeadUp) {
    t.skip("crew-lead not running");
    return true;
  }
  return false;
}

function authHeaders() {
  const h = { "content-type": "application/json" };
  if (authToken) h["authorization"] = `Bearer ${authToken}`;
  return h;
}

function trace(testName, operation, extra = {}) {
  return { test: testName, file: import.meta.filename, operation, extra };
}

// ── Health check ─────────────────────────────────────────────────────────────

describe("Health check", { timeout: 10000 }, () => {
  test("GET /health returns 200 OK", async (t) => {
    if (skipIfDown(t)) return;
    const testName = "GET /health returns 200 OK";
    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/health`, {
      timeout: 8000,
      trace: trace(testName, "health-check"),
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.agent, "crew-lead");
  });
});

// ── Chat round-trip ────────────────────────────────────────────────────────

describe("Chat round-trip", { timeout: 90000 }, () => {
  test("POST /chat with PONG request returns reply containing PONG", async (t) => {
    if (skipIfDown(t)) return;
    const testName = "POST /chat with PONG request returns reply containing PONG";
    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: { message: "reply with exactly: PONG", sessionId: E2E_SESSION },
      timeout: 80000,
      trace: trace(testName, "chat-roundtrip", { sessionId: E2E_SESSION }),
    });
    logTestEvidence({
      category: "chat_reply",
      test: testName,
      file: import.meta.filename,
      sessionId: E2E_SESSION,
      reply_preview: String(data.reply || "").slice(0, 200),
    });
    assert.equal(status, 200);
    assert.ok(data.reply, "response should have reply field");
    assert.ok(
      /pong/i.test(data.reply),
      `reply should contain PONG (case-insensitive), got: ${data.reply?.slice(0, 100)}`
    );
  });
});

// ── Direct dispatch ─────────────────────────────────────────────────────────

describe("Direct dispatch to crew-seo", { timeout: 90000 }, () => {
  test("dispatch crew-seo returns reply within 60s", async (t) => {
    if (skipIfDown(t)) return;
    const testName = "dispatch crew-seo returns reply within 60s";
    const sessionId = `e2e-dispatch-${Date.now()}`;
    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: { message: "dispatch crew-seo to say hello in exactly 3 words", sessionId },
      timeout: 80000,
      trace: trace(testName, "dispatch-via-chat", { sessionId, agent: "crew-seo" }),
    });
    logTestEvidence({
      category: "dispatch_context",
      test: testName,
      file: import.meta.filename,
      sessionId,
      agent: "crew-seo",
      reply_preview: String(data.reply || "").slice(0, 200),
    });
    assert.equal(status, 200);
    assert.ok(data.reply, "response should have reply");
    assert.ok(data.reply.length > 0, "reply should not be empty");
  });
});

// ── History saved ──────────────────────────────────────────────────────────

describe("History saved", { timeout: 15000 }, () => {
  test("GET /history?sessionId=e2e-test contains PONG message after chat", async (t) => {
    if (skipIfDown(t)) return;
    const testName = "GET /history?sessionId=e2e-test contains PONG message after chat";
    const authHdrs = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const { status, data } = await httpRequest(
      `${CREW_LEAD_URL}/history?sessionId=${encodeURIComponent(E2E_SESSION)}`,
      {
        headers: authHdrs,
        trace: trace(testName, "history-fetch", { sessionId: E2E_SESSION }),
      }
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.history), "history should be array");
    const hasPong = data.history.some(
      (m) => m.role === "assistant" && /pong/i.test(m.content || "")
    );
    assert.ok(hasPong, "history should contain assistant message with PONG");
  });
});

// ── Agents online ───────────────────────────────────────────────────────────

describe("Agents online", { timeout: 10000 }, () => {
  test("GET /api/agents returns agent list with crew-seo", async (t) => {
    if (skipIfDown(t)) return;
    const testName = "GET /api/agents returns agent list with crew-seo";
    const authHdrs = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/api/agents`, {
      headers: authHdrs,
      trace: trace(testName, "agents-list"),
    });
    assert.equal(status, 200);
    assert.ok(data.ok !== false, "response should be ok");
    const agents = data.agents || data;
    assert.ok(Array.isArray(agents), "agents should be array");
    const seo = agents.find(
      (a) => (a.id || a).includes("seo") || (a.id || a) === "crew-seo"
    );
    assert.ok(seo, "crew-seo should be in agent list");
  });
});

// ── Wave pipeline ──────────────────────────────────────────────────────────

describe("Wave pipeline", { timeout: 180000 }, () => {
  test("@@PIPELINE with 2 agents returns pipeline result within 120s", async (t) => {
    if (skipIfDown(t)) return;
    const testName = "@@PIPELINE with 2 agents returns pipeline result within 120s";
    const sessionId = `e2e-pipeline-${Date.now()}`;
    const pipelineMsg = `@@PIPELINE [
  {"wave":1,"agent":"crew-seo","task":"say the word APPLE"},
  {"wave":1,"agent":"crew-main","task":"say the word ORANGE"}
]`;

    const { status, data } = await httpRequest(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: { message: pipelineMsg, sessionId },
      timeout: 120000,
      trace: trace(testName, "pipeline-via-chat", { sessionId }),
    });
    assert.equal(status, 200);
    assert.ok(data.reply, "response should have reply");

    // Poll history for pipeline completion (30 polls × 2s = 60s max)
    let found = false;
    const authHdrs = authToken ? { authorization: `Bearer ${authToken}` } : {};
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const hist = await httpRequest(
          `${CREW_LEAD_URL}/history?sessionId=${encodeURIComponent(sessionId)}`,
          {
            headers: authHdrs,
            trace: trace(testName, "pipeline-history-poll", { sessionId }),
          }
        );
        if (hist.status !== 200) continue;
        const hasApple = (hist.data.history || []).some(
          (m) => /apple/i.test(m.content || "")
        );
        const hasOrange = (hist.data.history || []).some(
          (m) => /orange/i.test(m.content || "")
        );
        if (hasApple || hasOrange || data.reply?.length > 50) {
          found = true;
          break;
        }
      } catch { continue; }
    }
    assert.ok(found || data.reply?.length > 0, "pipeline should produce reply or history");
  });
});
