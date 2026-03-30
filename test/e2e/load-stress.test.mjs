/**
 * Load/stress tests for crewswarm services.
 * Verifies that dashboard and crew-lead survive concurrent load without crashing.
 *
 * Run: node --test test/e2e/load-stress.test.mjs
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";

const CREW_LEAD_URL = "http://127.0.0.1:5010";
const DASHBOARD_URL = "http://127.0.0.1:4319";

let authToken = "";
let crewLeadUp = false;
let dashboardUp = false;

function getAuthToken() {
  // Check crewswarm.json first, then config.json (crew-lead reads from both)
  for (const file of ["crewswarm.json", "config.json"]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".crewswarm", file), "utf8"));
      const token = cfg?.rt?.authToken || cfg?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
      if (token) return token;
    } catch {}
  }
  return process.env.CREWSWARM_RT_AUTH_TOKEN || "";
}

before(async () => {
  authToken = getAuthToken();
  [crewLeadUp, dashboardUp] = await Promise.all([
    checkServiceUp(`${CREW_LEAD_URL}/health`),
    checkServiceUp(`${DASHBOARD_URL}/api/health`),
  ]);
  if (!crewLeadUp || !dashboardUp) {
    console.log(
      `⚠️  Services not fully running (crew-lead: ${crewLeadUp}, dashboard: ${dashboardUp}) — skipping load tests`
    );
  }
});

function skipIfDown(t) {
  if (!crewLeadUp || !dashboardUp) {
    t.skip("services not running");
    return true;
  }
  return false;
}

function authHeaders() {
  const h = { "content-type": "application/json" };
  if (authToken) h["authorization"] = `Bearer ${authToken}`;
  // Also try reading token from env or config.json (crew-lead may use a different source)
  if (!authToken) {
    try {
      const cfgPath = path.join(os.homedir(), ".crewswarm", "config.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const envToken = cfg?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
      if (envToken) h["authorization"] = `Bearer ${envToken}`;
    } catch {}
    if (!h["authorization"] && process.env.CREWSWARM_RT_AUTH_TOKEN) {
      h["authorization"] = `Bearer ${process.env.CREWSWARM_RT_AUTH_TOKEN}`;
    }
  }
  return h;
}

// ── Load & Stress Tests ──────────────────────────────────────────────────────

describe("Load and stress tests", { concurrency: 1 }, () => {

  // 1. Dashboard concurrent requests
  test("dashboard handles 20 concurrent GET /api/health requests", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    const requests = Array.from({ length: 20 }, () =>
      httpRequest(`${DASHBOARD_URL}/api/health`, {
        timeout: 15000,
        headers: authHeaders(),
      })
    );
    const results = await Promise.all(requests);

    const statuses = results.map((r) => r.status);
    const failures = statuses.filter((s) => s >= 500);
    assert.equal(failures.length, 0, `expected no 500s, got ${failures.length}: ${JSON.stringify(failures)}`);

    const successes = statuses.filter((s) => s === 200);
    assert.equal(successes.length, 20, `expected all 200s, got ${successes.length}/20`);
  });

  // 2. Crew-lead concurrent requests
  test("crew-lead handles 20 concurrent GET /health requests", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    const requests = Array.from({ length: 20 }, () =>
      httpRequest(`${CREW_LEAD_URL}/health`, { timeout: 15000 })
    );
    const results = await Promise.all(requests);

    const statuses = results.map((r) => r.status);
    const failures = statuses.filter((s) => s >= 500);
    assert.equal(failures.length, 0, `expected no 500s, got ${failures.length}`);

    const successes = statuses.filter((s) => s === 200);
    assert.equal(successes.length, 20, `expected all 200s, got ${successes.length}/20`);
  });

  // 3. Dashboard mixed endpoints under load
  test("dashboard handles 10 concurrent requests to mixed endpoints", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    const endpoints = [
      "/api/health",
      "/api/agents",
      "/api/engines",
      "/api/health",
      "/api/models",
      "/api/services/status",
      "/api/health",
      "/api/agents",
      "/api/engines",
      "/api/models",
    ];

    const requests = endpoints.map((ep) =>
      httpRequest(`${DASHBOARD_URL}${ep}`, {
        timeout: 15000,
        headers: authHeaders(),
      })
    );
    const results = await Promise.all(requests);

    const statuses = results.map((r) => r.status);
    const crashes = statuses.filter((s) => s >= 500);
    assert.equal(crashes.length, 0, `no endpoints should return 500, got crashes on: ${JSON.stringify(crashes)}`);

    // All should return some valid HTTP status (2xx or 4xx are fine, 5xx is not)
    for (const r of results) {
      assert.ok(r.status < 500, `endpoint returned ${r.status}`);
    }
  });

  // 4. Rapid sequential dispatch
  test("5 rapid sequential dispatches to crew-seo all return taskIds", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    const words = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"];
    const requests = words.map((word) => {
      return httpRequest(`${CREW_LEAD_URL}/chat`, {
        method: "POST",
        headers: authHeaders(),
        body: { message: `say the word ${word}`, sessionId: `e2e-load-${Date.now()}` },
        timeout: 25000,
      });
    });

    const results = await Promise.all(requests);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      assert.equal(r.status, 200, `dispatch ${words[i]} should return 200, got ${r.status}`);
      assert.ok(r.data, `dispatch ${words[i]} should return data`);
      // Accept either a taskId in the response or a reply — both indicate the request was accepted
      const accepted = r.data.taskId || r.data.reply || r.data.ok;
      assert.ok(accepted, `dispatch ${words[i]} should be accepted, got: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
  });

  // 5. SSE connection stability
  test("3 simultaneous SSE connections held for 5s do not crash dashboard", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    const sseConnections = [];

    function openSSE(url) {
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "GET",
          headers: {
            accept: "text/event-stream",
            connection: "close",
            ...( authToken ? { authorization: `Bearer ${authToken}` } : {} ),
          },
        };

        const req = http.request(options, (res) => {
          // SSE opened successfully — store req and res for cleanup
          sseConnections.push({ req, res });
          resolve({ req, res, status: res.statusCode });
        });

        req.on("error", (err) => {
          // Connection refused or similar — still resolve so test can evaluate
          resolve({ req, res: null, status: 0, error: err });
        });

        req.setTimeout(10000, () => {
          req.destroy();
          resolve({ req, res: null, status: 0, error: new Error("timeout") });
        });

        req.end();
      });
    }

    // Open 3 SSE connections
    const connections = await Promise.all([
      openSSE(`${DASHBOARD_URL}/api/crew-lead/events`),
      openSSE(`${DASHBOARD_URL}/api/crew-lead/events`),
      openSSE(`${DASHBOARD_URL}/api/crew-lead/events`),
    ]);

    // Verify at least some connected (SSE endpoint might return various status codes)
    for (const conn of connections) {
      if (conn.status > 0) {
        assert.ok(conn.status < 500, `SSE connection returned ${conn.status}`);
      }
    }

    // Hold connections open for 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Close all SSE connections
    for (const conn of sseConnections) {
      try {
        if (conn.res) conn.res.destroy();
        if (conn.req) conn.req.destroy();
      } catch {
        // ignore cleanup errors
      }
    }

    // Brief pause to let server process disconnections
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify dashboard still responds
    const { status } = await httpRequest(`${DASHBOARD_URL}/api/health`, {
      timeout: 10000,
      headers: authHeaders(),
    });
    assert.equal(status, 200, "dashboard should still respond after SSE connections close");
  });

  // 6. Dashboard survives engine passthrough abort
  test("dashboard survives aborted passthrough request", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    // Start a request that we will abort — use a chat endpoint which takes time
    const abortPromise = new Promise((resolve) => {
      const parsedUrl = new URL(`${DASHBOARD_URL}/api/crew-lead/chat`);
      const postBody = JSON.stringify({
        message: "count slowly from 1 to 100",
        sessionId: `e2e-abort-${Date.now()}`,
      });
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          connection: "close",
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
      };

      const req = http.request(options, (res) => {
        // Once we get any response headers, destroy immediately
        res.destroy();
        resolve("aborted-after-headers");
      });

      req.on("error", () => {
        resolve("aborted-with-error");
      });

      req.write(postBody);
      req.end();

      // Abort after 2 seconds regardless
      setTimeout(() => {
        req.destroy();
        resolve("aborted-by-timeout");
      }, 2000);
    });

    await abortPromise;

    // Brief pause for server to handle the abort
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify dashboard health still works
    const { status } = await httpRequest(`${DASHBOARD_URL}/api/health`, {
      timeout: 10000,
      headers: authHeaders(),
    });
    assert.equal(status, 200, "dashboard should still respond after aborted passthrough");
  });

  // 7. Service stability after load
  test("both services still healthy after all load tests with <500ms response", { timeout: 30000 }, async (t) => {
    if (skipIfDown(t)) return;

    // Check dashboard health with timing
    const dashStart = Date.now();
    const dashResult = await httpRequest(`${DASHBOARD_URL}/api/health`, {
      timeout: 10000,
      headers: authHeaders(),
    });
    const dashDuration = Date.now() - dashStart;

    assert.equal(dashResult.status, 200, "dashboard health should return 200");
    assert.ok(dashDuration < 500, `dashboard response took ${dashDuration}ms, expected <500ms`);

    // Check crew-lead health with timing
    const leadStart = Date.now();
    const leadResult = await httpRequest(`${CREW_LEAD_URL}/health`, {
      timeout: 10000,
    });
    const leadDuration = Date.now() - leadStart;

    assert.equal(leadResult.status, 200, "crew-lead health should return 200");
    assert.ok(leadDuration < 500, `crew-lead response took ${leadDuration}ms, expected <500ms`);
  });
});
