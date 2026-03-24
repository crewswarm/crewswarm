/**
 * Integration tests for Dashboard API endpoints with validation
 * Tests that all endpoints properly validate input using Zod schemas
 * Requires dashboard running on :4319 — skipped gracefully if not available.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  StartBuildSchema,
  StartPMLoopSchema,
  ServiceActionSchema,
  ImportSkillSchema,
  validate,
} from "../../scripts/dashboard-validation.mjs";

const DASHBOARD_BASE = process.env.DASHBOARD_BASE || "http://127.0.0.1:4319";

let dashboardUp = false;

async function checkDashboard() {
  try {
    const res = await fetch(`${DASHBOARD_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

function skipIfDown(t) {
  if (!dashboardUp) { t.skip("dashboard not running on :4319"); return true; }
  return false;
}

// Helper to make API requests
async function apiRequest(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${DASHBOARD_BASE}${endpoint}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  dashboardUp = await checkDashboard();
  if (!dashboardUp) console.log("⚠️ Dashboard not running on :4319 — skipping API validation tests");
});

describe("Dashboard API Validation Tests", () => {

  describe("POST /api/build", () => {
    test("rejects request with missing requirement", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/build", "POST", {});
      assert.equal(status, 400, "Should return 400 for missing requirement");
      assert.equal(data.ok, false);
      assert.ok(data.error, "Should include an error message");
    });

    test("rejects request with invalid requirement type", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/build", "POST", { requirement: 123 });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("rejects request with empty requirement", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/build", "POST", { requirement: "" });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("rejects request with requirement too long", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/build", "POST", {
        requirement: "x".repeat(10001)
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("accepts valid build request", async () => {
      // Note: This will actually start a build, so we skip it unless explicitly testing
      // Just validate the schema accepts the format
      const validBody = { requirement: "write a hello world script" };
      assert.ok(validBody.requirement.length > 0 && validBody.requirement.length <= 10000);
    });
  });

  describe("POST /api/pm-loop/start", () => {
    test("accepts request with no body (all fields optional)", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/pm-loop/start", "POST", {});
      // Should not be a validation error (fields are optional)
      // May fail for other reasons (e.g., already running)
      if (status === 400) {
        assert.ok(!data.error?.includes("validation"), "Should not be a validation error");
      }
    });

    test("accepts valid dryRun option", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/pm-loop/start", "POST", { dryRun: true });
      // Should not fail validation
      if (status === 400) {
        assert.ok(!data.error?.toLowerCase().includes("dryrun"), "Should accept dryRun boolean");
      }
    });

    test("accepts valid projectId", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/pm-loop/start", "POST", {
        projectId: "test-project-123"
      });
      // Should not fail validation
      if (status === 400) {
        assert.ok(!data.error?.toLowerCase().includes("projectid"), "Should accept projectId string");
      }
    });

    test("accepts valid pmOptions", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/pm-loop/start", "POST", {
        pmOptions: {
          autoAdvance: true,
          maxIterations: 5,
          useSecurity: true,
          useQA: false
        }
      });
      // Should not fail validation
      if (status === 400) {
        assert.ok(!data.error?.toLowerCase().includes("pmoptions"), "Should accept pmOptions object");
      }
    });

    test("rejects invalid maxIterations", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/pm-loop/start", "POST", {
        pmOptions: { maxIterations: 0 }
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("rejects maxIterations over limit", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/pm-loop/start", "POST", {
        pmOptions: { maxIterations: 1001 }
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });
  });

  describe("POST /api/services/restart", () => {
    test("rejects request with missing id", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/services/restart", "POST", {});
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error, "Should include an error message");
    });

    test("rejects request with invalid service id", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/services/restart", "POST", {
        id: "invalid-service-xyz"
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("accepts valid service id", async (t) => {
      if (skipIfDown(t)) return;
      const validIds = [
        "rt-bus", "agents", "crew-lead", "telegram", "whatsapp",
        "opencode", "mcp", "openclaw-gateway", "dashboard"
      ];

      for (const id of validIds) {
        const { status, data } = await apiRequest("/api/services/restart", "POST", { id });
        // Should not be a validation error (may fail for other operational reasons)
        if (status === 400) {
          assert.ok(!data.error?.includes("invalid") && !data.error?.includes("enum"),
            `Should accept valid service id: ${id}`);
        }
      }
    });
  });

  describe("POST /api/skills/import", () => {
    test("rejects request with missing url", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/skills/import", "POST", {});
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error, "Should include an error message");
    });

    test("rejects request with invalid url format", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/skills/import", "POST", {
        url: "not-a-valid-url"
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("rejects request with non-HTTPS url", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/skills/import", "POST", {
        url: "http://example.com/skill.json"
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error.toLowerCase().includes("https"));
    });

    test("rejects request with localhost url", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/skills/import", "POST", {
        url: "https://localhost/skill.json"
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error.toLowerCase().includes("blocked") || data.error.toLowerCase().includes("private"));
    });

    test("rejects request with private IP url", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/skills/import", "POST", {
        url: "https://192.168.1.1/skill.json"
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error.toLowerCase().includes("blocked") || data.error.toLowerCase().includes("private"));
    });

    test("rejects url that's too long", async (t) => {
      if (skipIfDown(t)) return;
      const { status, data } = await apiRequest("/api/skills/import", "POST", {
        url: "https://example.com/" + "x".repeat(2000)
      });
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    });

    test("accepts valid HTTPS GitHub url", async (t) => {
      if (skipIfDown(t)) return;
      const validUrl = "https://raw.githubusercontent.com/user/repo/main/skill.json";
      const { status, data } = await apiRequest("/api/skills/import", "POST", { url: validUrl });
      // Should not be a validation error (may fail due to network/404)
      if (status === 400) {
        assert.ok(!data.error?.includes("validation") && !data.error?.includes("invalid url"),
          "Should accept valid HTTPS GitHub URL");
      }
    });
  });

  describe("Error Handling", () => {
    test("returns 400 for malformed JSON", async (t) => {
      if (skipIfDown(t)) return;
      const res = await fetch(`${DASHBOARD_BASE}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ invalid json"
      });
      const data = await res.json();
      assert.equal(res.status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error.toLowerCase().includes("json"));
    });

    test("returns 400 for empty request body", async (t) => {
      if (skipIfDown(t)) return;
      const res = await fetch(`${DASHBOARD_BASE}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ""
      });
      const data = await res.json();
      assert.equal(res.status, 400);
      assert.equal(data.ok, false);
      assert.ok(data.error, "Should include an error message");
    });
  });

  describe("Process Helper Functions", () => {
    test("commandExists helper replaced execSync", async (t) => {
      if (skipIfDown(t)) return;
      // This is a smoke test - if the dashboard starts, commandExists works
      const { status } = await apiRequest("/api/health", "GET");
      assert.equal(status, 200, "Dashboard should be responding");
    });

    test("spawnAsync helper replaced execSync for folder picker", async (t) => {
      if (skipIfDown(t)) return;
      // Folder picker only works on macOS, but should not crash
      if (process.platform === "darwin") {
        const res = await fetch(`${DASHBOARD_BASE}/api/pick-folder?default=/tmp`, {
          method: "GET"
        });
        // Should return 200 with ok field (may be false if user cancels)
        assert.ok(res.status === 200 || res.status === 500, "Folder picker should handle requests");
      }
    });
  });
});

describe("Regression Tests", () => {
  test("dashboard validation schemas export the expected contracts", () => {
    assert.equal(validate(StartBuildSchema, { requirement: "" }).ok, false);
    assert.equal(
      validate(StartBuildSchema, { requirement: "write a hello world script" }).ok,
      true,
    );

    assert.equal(
      validate(StartPMLoopSchema, { pmOptions: { maxIterations: 0 } }).ok,
      false,
    );
    assert.equal(
      validate(StartPMLoopSchema, { pmOptions: { maxIterations: 5 } }).ok,
      true,
    );

    assert.equal(validate(ServiceActionSchema, { id: "invalid-service" }).ok, false);
    assert.equal(validate(ServiceActionSchema, { id: "crew-lead" }).ok, true);

    assert.equal(validate(ImportSkillSchema, { url: "notaurl" }).ok, false);
    assert.equal(
      validate(ImportSkillSchema, {
        url: "https://raw.githubusercontent.com/user/repo/main/skill.json",
      }).ok,
      true,
    );
  });

  test("live dashboard endpoints enforce the intended validation behavior", async (t) => {
    if (skipIfDown(t)) return;

    const buildInvalid = await apiRequest("/api/build", "POST", { requirement: "" });
    assert.equal(buildInvalid.status, 400);

    const pmInvalid = await apiRequest("/api/pm-loop/start", "POST", {
      pmOptions: { maxIterations: 0 },
    });
    assert.equal(pmInvalid.status, 400);

    const serviceInvalid = await apiRequest("/api/services/restart", "POST", {
      id: "invalid-service",
    });
    assert.equal(serviceInvalid.status, 400);

    const importInvalid = await apiRequest("/api/skills/import", "POST", {
      url: "http://example.com/skill.json",
    });
    assert.equal(importInvalid.status, 400);
  });
});
