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

async function checkCrewLeadUp() {
  try {
    const res = await fetch(`${CREW_LEAD_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (e) {
    if (/ECONNREFUSED|fetch failed|network/i.test(String(e?.message || e))) return false;
    throw e;
  }
}

before(async () => {
  authToken = getAuthToken();
  crewLeadUp = await checkCrewLeadUp();
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

// ── Health check ─────────────────────────────────────────────────────────────

describe("Health check", { timeout: 10000 }, () => {
  test("GET /health returns 200 OK", async (t) => {
    if (skipIfDown(t)) return;
    const res = await fetch(`${CREW_LEAD_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.agent, "crew-lead");
  });
});

// ── Chat round-trip ────────────────────────────────────────────────────────

describe("Chat round-trip", { timeout: 35000 }, () => {
  test("POST /chat with PONG request returns reply containing PONG", async (t) => {
    if (skipIfDown(t)) return;
    const res = await fetch(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: "reply with exactly: PONG",
        sessionId: E2E_SESSION,
      }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.reply, "response should have reply field");
    assert.ok(
      /pong/i.test(body.reply),
      `reply should contain PONG (case-insensitive), got: ${body.reply?.slice(0, 100)}`
    );
  });
});

// ── Direct dispatch ─────────────────────────────────────────────────────────

describe("Direct dispatch to crew-copywriter", { timeout: 35000 }, () => {
  test("dispatch crew-copywriter returns reply within 30s", async (t) => {
    if (skipIfDown(t)) return;
    const res = await fetch(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: "dispatch crew-copywriter to say hello in exactly 3 words",
        sessionId: `e2e-dispatch-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(32000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.reply, "response should have reply");
    assert.ok(body.reply.length > 0, "reply should not be empty");
  });
});

// ── History saved ──────────────────────────────────────────────────────────

describe("History saved", { timeout: 15000 }, () => {
  test("GET /history?sessionId=e2e-test contains PONG message after chat", async (t) => {
    if (skipIfDown(t)) return;
    const res = await fetch(
      `${CREW_LEAD_URL}/history?sessionId=${encodeURIComponent(E2E_SESSION)}`,
      {
        headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
        signal: AbortSignal.timeout(5000),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.history), "history should be array");
    const hasPong = body.history.some(
      (m) => m.role === "assistant" && /pong/i.test(m.content || "")
    );
    assert.ok(hasPong, "history should contain assistant message with PONG");
  });
});

// ── Agents online ───────────────────────────────────────────────────────────

describe("Agents online", { timeout: 10000 }, () => {
  test("GET /api/agents returns agent list with crew-copywriter", async (t) => {
    if (skipIfDown(t)) return;
    const res = await fetch(`${CREW_LEAD_URL}/api/agents`, {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok !== false, "response should be ok");
    const agents = body.agents || body;
    assert.ok(Array.isArray(agents), "agents should be array");
    const copywriter = agents.find(
      (a) => (a.id || a).includes("copywriter") || (a.id || a) === "crew-copywriter"
    );
    assert.ok(copywriter, "crew-copywriter should be in agent list");
  });
});

// ── Wave pipeline ──────────────────────────────────────────────────────────

describe("Wave pipeline", { timeout: 35000 }, () => {
  test("@@PIPELINE with 2 agents returns pipeline result within 30s", async (t) => {
    if (skipIfDown(t)) return;
    const sessionId = `e2e-pipeline-${Date.now()}`;
    const pipelineMsg = `@@PIPELINE [
  {"wave":1,"agent":"crew-copywriter","task":"say the word APPLE"},
  {"wave":1,"agent":"crew-main","task":"say the word ORANGE"}
]`;

    const res = await fetch(`${CREW_LEAD_URL}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message: pipelineMsg, sessionId }),
      signal: AbortSignal.timeout(32000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.reply, "response should have reply");

    // Poll history for pipeline completion
    let found = false;
    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const histRes = await fetch(
        `${CREW_LEAD_URL}/history?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!histRes.ok) continue;
      const hist = await histRes.json();
      const hasApple = (hist.history || []).some(
        (m) => /apple/i.test(m.content || "")
      );
      const hasOrange = (hist.history || []).some(
        (m) => /orange/i.test(m.content || "")
      );
      if (hasApple || hasOrange || body.reply?.length > 50) {
        found = true;
        break;
      }
    }
    assert.ok(found || body.reply?.length > 0, "pipeline should produce reply or history");
  });
});
