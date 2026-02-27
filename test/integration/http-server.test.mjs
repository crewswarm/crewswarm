/**
 * Integration tests for lib/crew-lead/http-server.mjs
 * Starts the HTTP server on a random port with minimal mock deps.
 * No Docker, no crew-lead daemon, no RT bus required.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { initHttpServer, createAndStartServer } from "../../lib/crew-lead/http-server.mjs";

const TEST_PORT = 15099;
const BASE = `http://localhost:${TEST_PORT}`;

// ── Minimal mock deps ──────────────────────────────────────────────────────────

function makeMockDeps() {
  return {
    sseClients: new Set(),
    loadConfig: () => ({
      model: "test/model",
      knownAgents: ["crew-coder", "crew-qa"],
      agentRoster: [
        { id: "crew-coder", name: "Fuller", role: "Full Stack Coder", model: "test/model" },
        { id: "crew-qa",    name: "Testy",  role: "QA",               model: "test/model" },
      ],
      providers: {},
    }),
    loadHistory:    () => [],
    clearHistory:   () => {},
    appendHistory:  () => {},
    broadcastSSE:   () => {},
    handleChat:     async () => ({ reply: "ok" }),
    confirmProject: () => {},
    pendingProjects: new Map(),
    dispatchTask:   () => "test-task-id",
    pendingDispatches: new Map(),
    pendingPipelines: new Map(),
    resolveAgentId: (_cfg, id) => id,
    readAgentTools: () => ({ tools: ["read_file", "write_file"] }),
    writeAgentTools: () => {},
    activeOpenCodeAgents: new Map(),
    agentTimeoutCounts: new Map(),
    crewswarmToolNames: ["read_file", "write_file"],
    classifyTask:   async () => null,
    tryRead:        () => null,
    resolveSkillAlias: (name) => name,
    connectRT:      () => {},
    historyDir:     "/tmp/test-history",
    dispatchTimeoutMs: 30000,
    dispatchTimeoutInterval: null,
    setDispatchTimeoutInterval: (v) => { void v; },
    checkDispatchTimeouts: () => {},
    getRTToken:     () => "",  // empty = no auth (open access)
    getRtPublish:   () => null,
    telemetrySchemaVersion: "1.0",
    readTelemetryEvents: () => [],
    bgConsciousnessRef: { enabled: false, model: "" },
    bgConsciousnessIntervalMs: 900000,
    cursorWavesRef: { enabled: false },
    claudeCodeRef:  { enabled: false },
  };
}

let server;
let dispatchInterval = null;

before(async () => {
  const deps = makeMockDeps();
  // Track the interval so we can clear it in after() to unblock event loop
  deps.setDispatchTimeoutInterval = (v) => { dispatchInterval = v; };
  initHttpServer(deps);
  server = createAndStartServer(TEST_PORT);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
});

after(async () => {
  if (dispatchInterval) clearInterval(dispatchInterval);
  await new Promise((resolve) => server.close(resolve));
});

// ── /health ───────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns 200 with ok:true", async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.agent, "crew-lead");
    assert.equal(body.port, TEST_PORT);
  });
});

// ── /status ───────────────────────────────────────────────────────────────────

describe("GET /status", () => {
  test("returns 200 with model and rtConnected fields", async () => {
    const res = await fetch(`${BASE}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, "test/model");
    assert.equal(body.rtConnected, false);
  });
});

// ── /api/classify ─────────────────────────────────────────────────────────────

describe("POST /api/classify", () => {
  test("returns 400 when task is missing", async () => {
    const res = await fetch(`${BASE}/api/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.toLowerCase().includes("task"));
  });

  test("returns 200 with skipped:true when classifyTask returns null (no API key)", async () => {
    const res = await fetch(`${BASE}/api/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "write a login page with JWT" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.skipped, true);
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${BASE}/api/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(res.status, 400);
  });
});

// ── /api/agents ───────────────────────────────────────────────────────────────

describe("GET /api/agents", () => {
  test("returns 200 with agents array", async () => {
    const res = await fetch(`${BASE}/api/agents`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.agents));
    assert.ok(body.agents.length >= 2);
  });

  test("each agent has id, tools, and inOpenCode fields", async () => {
    const res = await fetch(`${BASE}/api/agents`);
    const body = await res.json();
    for (const agent of body.agents) {
      assert.ok(agent.id, "agent should have id");
      assert.ok(Array.isArray(agent.tools), `agent ${agent.id} should have tools array`);
      assert.ok("inOpenCode" in agent, `agent ${agent.id} should have inOpenCode field`);
    }
  });
});

// ── /api/skills ───────────────────────────────────────────────────────────────

describe("GET /api/skills", () => {
  test("returns 200 with skills array", async () => {
    const res = await fetch(`${BASE}/api/skills`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.skills));
  });
});

describe("POST /api/skills", () => {
  test("returns 400 when name is missing", async () => {
    const res = await fetch(`${BASE}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/api" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.includes("name"));
  });

  test("returns 400 when url is missing", async () => {
    const res = await fetch(`${BASE}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-skill" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});

// ── /api/spending ─────────────────────────────────────────────────────────────

describe("GET /api/spending", () => {
  test("returns 200 with spending and caps fields", async () => {
    const res = await fetch(`${BASE}/api/spending`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok("spending" in body, "should have spending field");
    assert.ok("caps" in body, "should have caps field");
  });

  test("spending has date, global, and agents fields", async () => {
    const res = await fetch(`${BASE}/api/spending`);
    const body = await res.json();
    assert.ok(body.spending.date, "spending.date should be present");
    assert.ok(typeof body.spending.global === "object");
    assert.ok(typeof body.spending.agents === "object");
  });
});

// ── OPTIONS (CORS preflight) ──────────────────────────────────────────────────

describe("OPTIONS preflight", () => {
  test("returns 204 for CORS preflight", async () => {
    const res = await fetch(`${BASE}/health`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

describe("404 handling", () => {
  test("returns 404 for unknown routes", async () => {
    const res = await fetch(`${BASE}/api/nonexistent-route-xyz`);
    assert.equal(res.status, 404);
  });
});
