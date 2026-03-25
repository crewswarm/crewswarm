/**
 * Integration tests for Workflow CRUD APIs.
 *
 * Coverage:
 *  - Save (POST /api/workflows/save) — creates file, appears in list
 *  - List (GET /api/workflows/list) — correct response shape
 *  - Get item (GET /api/workflows/item) — full detail with stages
 *  - Delete (POST /api/workflows/delete) — removed from list
 *  - Validation: reject workflow with no stages/steps
 *  - Validation: reject invalid cron expression
 *  - Run state tracking basics (POST /api/workflows/run, GET /api/workflows/status)
 *
 * When the dashboard is NOT running on :4319 (or DASHBOARD_BASE), all HTTP
 * tests are skipped gracefully.  Pure file-system / helper-logic tests always
 * run regardless.
 *
 * Environment variables:
 *   DASHBOARD_BASE           — override dashboard URL (default http://127.0.0.1:4319)
 *   CREWSWARM_CONFIG_DIR     — set on the running dashboard to redirect pipelines dir
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";

// ── Dashboard connectivity ────────────────────────────────────────────────────

const DASHBOARD_BASE = process.env.DASHBOARD_BASE || "http://127.0.0.1:4319";

let dashboardUp = false;

function skipIfDown(t) {
  if (!dashboardUp) {
    t.skip("dashboard not running — skipping live HTTP test");
    return true;
  }
  return false;
}

// ── HTTP helpers (uses http.request — Node 25 fetch unreliable on localhost) ──

async function api(endpoint, method = "GET", body = null) {
  return httpRequest(`${DASHBOARD_BASE}${endpoint}`, { method, body });
}

// ── Temp state dir for file-system tests ─────────────────────────────────────

let tempStateDir;
let pipelinesDir;

// ── File-system helpers (mirror dashboard.mjs logic without importing it) ────
//
// dashboard.mjs is not an ES module with exports — it runs as a top-level
// script and never calls `export`.  We replicate the minimal helpers needed
// for file-system–level tests so we can verify the on-disk contract without
// spawning the server.

function isValidWorkflowName(name) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(name || ""));
}

function isCronExpressionValid(expr) {
  const parts = String(expr || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 5) return false;
  // Each field must be non-empty; a simple structural check is sufficient here.
  return parts.every((p) => /^[\d*,\-/]+$/.test(p));
}

function getWorkflowFile(dir, name) {
  return join(dir, `${name}.json`);
}

async function ensurePipelinesDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function writeWorkflow(dir, name, workflow) {
  await ensurePipelinesDir(dir);
  const fp = getWorkflowFile(dir, name);
  await writeFile(fp, JSON.stringify(workflow, null, 2), "utf8");
  return fp;
}

async function listWorkflowsFromDir(dir) {
  const files = await readdir(dir).catch(() => []);
  const names = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter(isValidWorkflowName)
    .sort();

  const out = [];
  for (const name of names) {
    const raw = await readFile(getWorkflowFile(dir, name), "utf8").catch(() => "{}");
    const wf = JSON.parse(raw);
    out.push({
      name,
      description: wf.description || "",
      enabled: !!wf.enabled,
      schedule: String(wf.schedule || "").trim(),
      stageCount: Array.isArray(wf.stages) ? wf.stages.length : 0,
    });
  }
  return out;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(async () => {
  // Create isolated temp dir for file-system tests.
  tempStateDir = await mkdtemp(join(tmpdir(), "crewswarm-wf-crud-test-"));
  pipelinesDir = join(tempStateDir, "pipelines");
  await mkdir(pipelinesDir, { recursive: true });

  dashboardUp = await checkServiceUp(`${DASHBOARD_BASE}/api/health`, 8000);
  if (!dashboardUp) {
    await new Promise(r => setTimeout(r, 2000));
    dashboardUp = await checkServiceUp(`${DASHBOARD_BASE}/api/health`, 8000);
  }
  if (!dashboardUp) {
    console.log(
      `[workflow-crud] Dashboard not running on ${DASHBOARD_BASE} — HTTP tests will be skipped.`,
    );
  }
});

after(async () => {
  await rm(tempStateDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// FILE-SYSTEM LEVEL TESTS
// These run in every environment (no server required).
// ─────────────────────────────────────────────────────────────────────────────

describe("workflow file-system contract", () => {
  it("writes and reads a workflow JSON file", async () => {
    const wf = {
      description: "FS test workflow",
      enabled: false,
      schedule: "0 9 * * 1",
      stages: [{ agent: "crew-coder", task: "Say hello" }],
      updatedAt: new Date().toISOString(),
    };
    const fp = await writeWorkflow(pipelinesDir, "fs-test", wf);
    assert.ok(existsSync(fp), "file should exist after write");

    const raw = await readFile(fp, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.description, "FS test workflow");
    assert.equal(parsed.stages.length, 1);
  });

  it("listWorkflowsFromDir returns correct shape fields", async () => {
    await writeWorkflow(pipelinesDir, "list-shape-wf", {
      description: "List shape test",
      enabled: true,
      schedule: "*/30 * * * *",
      stages: [
        { agent: "crew-seo", task: "Generate tweet" },
        { agent: "crew-main", task: "Review tweet" },
      ],
    });

    const workflows = await listWorkflowsFromDir(pipelinesDir);
    const found = workflows.find((w) => w.name === "list-shape-wf");
    assert.ok(found, "workflow should appear in list");
    assert.equal(typeof found.name, "string");
    assert.equal(typeof found.description, "string");
    assert.equal(typeof found.enabled, "boolean");
    assert.equal(typeof found.schedule, "string");
    assert.equal(typeof found.stageCount, "number");
  });

  it("lists multiple workflows sorted alphabetically", async () => {
    await writeWorkflow(pipelinesDir, "zebra-wf", { stages: [{ agent: "a", task: "t" }] });
    await writeWorkflow(pipelinesDir, "alpha-wf", { stages: [{ agent: "a", task: "t" }] });
    await writeWorkflow(pipelinesDir, "mango-wf", { stages: [{ agent: "a", task: "t" }] });

    const workflows = await listWorkflowsFromDir(pipelinesDir);
    const names = workflows.map((w) => w.name);
    const idx = (n) => names.indexOf(n);
    assert.ok(idx("alpha-wf") < idx("mango-wf"), "alpha before mango");
    assert.ok(idx("mango-wf") < idx("zebra-wf"), "mango before zebra");
  });

  it("deleting the file removes it from the list", async () => {
    await writeWorkflow(pipelinesDir, "delete-me-fs", {
      stages: [{ agent: "crew-coder", task: "Do something" }],
    });

    let workflows = await listWorkflowsFromDir(pipelinesDir);
    assert.ok(
      workflows.some((w) => w.name === "delete-me-fs"),
      "should be in list before delete",
    );

    const fp = getWorkflowFile(pipelinesDir, "delete-me-fs");
    await rm(fp, { force: true });

    workflows = await listWorkflowsFromDir(pipelinesDir);
    assert.ok(
      !workflows.some((w) => w.name === "delete-me-fs"),
      "should not be in list after delete",
    );
  });

  it("stageCount reflects the number of stages written", async () => {
    await writeWorkflow(pipelinesDir, "stage-count-wf", {
      stages: [
        { agent: "crew-coder", task: "Step 1" },
        { agent: "crew-qa", task: "Step 2" },
        { agent: "crew-main", task: "Step 3" },
      ],
    });

    const workflows = await listWorkflowsFromDir(pipelinesDir);
    const found = workflows.find((w) => w.name === "stage-count-wf");
    assert.ok(found, "workflow should appear in list");
    assert.equal(found.stageCount, 3);
  });

  it("ignores files with invalid workflow names", async () => {
    // Write a file whose name would fail isValidWorkflowName
    await writeFile(
      join(pipelinesDir, "has spaces.json"),
      JSON.stringify({ stages: [] }),
      "utf8",
    );
    await writeFile(
      join(pipelinesDir, "../../traversal.json"),
      JSON.stringify({ stages: [] }),
      "utf8",
    ).catch(() => {
      // path traversal attempt may be silently ignored on some FS
    });

    const workflows = await listWorkflowsFromDir(pipelinesDir);
    assert.ok(
      !workflows.some((w) => w.name === "has spaces"),
      "names with spaces must be excluded",
    );
    assert.ok(
      !workflows.some((w) => w.name === "../../traversal"),
      "path-traversal names must be excluded",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION HELPER TESTS (always run, no server needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("workflow name validation", () => {
  it("accepts valid alphanumeric names", () => {
    assert.ok(isValidWorkflowName("hello"));
    assert.ok(isValidWorkflowName("my-workflow"));
    assert.ok(isValidWorkflowName("wf_01"));
    assert.ok(isValidWorkflowName("A1-B2_C3"));
  });

  it("rejects empty string", () => {
    assert.equal(isValidWorkflowName(""), false);
  });

  it("rejects names with spaces", () => {
    assert.equal(isValidWorkflowName("my workflow"), false);
  });

  it("rejects names with path separators", () => {
    assert.equal(isValidWorkflowName("../etc/passwd"), false);
    assert.equal(isValidWorkflowName("dir/name"), false);
  });

  it("rejects names exceeding 64 characters", () => {
    assert.equal(isValidWorkflowName("a".repeat(65)), false);
    assert.ok(isValidWorkflowName("a".repeat(64)));
  });

  it("rejects names with special shell characters", () => {
    assert.equal(isValidWorkflowName("wf;rm -rf /"), false);
    assert.equal(isValidWorkflowName("wf$(echo hi)"), false);
  });
});

describe("cron expression validation", () => {
  it("accepts standard 5-field expressions", () => {
    assert.ok(isCronExpressionValid("0 9 * * *"), "daily at 9am");
    assert.ok(isCronExpressionValid("*/15 * * * *"), "every 15 min");
    assert.ok(isCronExpressionValid("0 9 * * 1"), "mondays at 9am");
    assert.ok(isCronExpressionValid("30 18 1 * *"), "1st of month at 18:30");
  });

  it("rejects expressions with fewer than 5 fields", () => {
    assert.equal(isCronExpressionValid("0 9 *"), false);
    assert.equal(isCronExpressionValid("* * * *"), false);
    assert.equal(isCronExpressionValid(""), false);
  });

  it("rejects expressions with more than 5 fields", () => {
    assert.equal(isCronExpressionValid("0 9 * * * *"), false);
  });

  it("rejects non-numeric non-wildcard values", () => {
    assert.equal(isCronExpressionValid("@daily"), false);
    assert.equal(isCronExpressionValid("@hourly"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE HTTP TESTS — skipped when dashboard is not running
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/workflows/list", () => {
  it("returns ok:true with workflows array and timezone", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/list");
    assert.equal(status, 200, "should return 200");
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.workflows), "data.workflows should be an array");
    assert.equal(typeof data.timezone, "string", "data.timezone should be a string");
    assert.ok(data.timezone.length > 0, "timezone should not be empty");
  });

  it("each workflow item has the required shape fields", async (t) => {
    if (skipIfDown(t)) return;

    const { data } = await api("/api/workflows/list");
    for (const wf of data.workflows) {
      assert.equal(typeof wf.name, "string", `name must be string (got ${typeof wf.name})`);
      assert.equal(typeof wf.description, "string", "description must be string");
      assert.equal(typeof wf.enabled, "boolean", "enabled must be boolean");
      assert.equal(typeof wf.schedule, "string", "schedule must be string");
      assert.equal(typeof wf.stageCount, "number", "stageCount must be number");
    }
  });
});

describe("POST /api/workflows/save → list → item → delete lifecycle", () => {
  // Use a unique name per test run to avoid cross-test pollution.
  const wfName = `crud-test-${Date.now()}`;

  after(async () => {
    // Best-effort cleanup even if tests fail.
    if (dashboardUp) {
      await api("/api/workflows/delete", "POST", { name: wfName }).catch(() => {});
    }
  });

  it("saves a workflow and returns ok with filePath", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/save", "POST", {
      name: wfName,
      workflow: {
        description: "CRUD test workflow",
        enabled: false,
        schedule: "0 8 * * *",
        stages: [
          { agent: "crew-coder", task: "Write integration test" },
          { agent: "crew-qa", task: "Verify the test passes" },
        ],
      },
    });

    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.name, wfName);
    assert.equal(typeof data.filePath, "string", "filePath should be returned");
    assert.ok(data.filePath.endsWith(`${wfName}.json`), "filePath should end with <name>.json");
  });

  it("saved workflow appears in the list with correct shape", async (t) => {
    if (skipIfDown(t)) return;

    const { data } = await api("/api/workflows/list");
    assert.equal(data.ok, true);

    const found = data.workflows.find((w) => w.name === wfName);
    assert.ok(found, `${wfName} should appear in list after save`);
    assert.equal(found.description, "CRUD test workflow");
    assert.equal(found.enabled, false);
    assert.equal(found.schedule, "0 8 * * *");
    assert.equal(found.stageCount, 2);
  });

  it("GET /api/workflows/item returns full workflow detail with stages", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api(
      `/api/workflows/item?name=${encodeURIComponent(wfName)}`,
    );
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);
    assert.equal(data.name, wfName);
    assert.ok(data.workflow, "response should have workflow object");
    assert.ok(
      Array.isArray(data.workflow.stages),
      "workflow.stages should be an array",
    );
    assert.equal(data.workflow.stages.length, 2, "should have 2 stages");
    assert.equal(data.workflow.stages[0].agent, "crew-coder");
    assert.equal(data.workflow.stages[1].agent, "crew-qa");
    assert.equal(typeof data.runState, "object", "runState should be present");
    assert.equal(typeof data.filePath, "string", "filePath should be present");
    assert.ok(typeof data.cronExample === "string", "cronExample should be present");
  });

  it("deletes the workflow and it disappears from list", async (t) => {
    if (skipIfDown(t)) return;

    const { status: delStatus, data: delData } = await api(
      "/api/workflows/delete",
      "POST",
      { name: wfName },
    );
    assert.equal(delStatus, 200, `delete should return 200, got ${delStatus}`);
    assert.equal(delData.ok, true);

    const { data: listData } = await api("/api/workflows/list");
    assert.ok(
      !listData.workflows.some((w) => w.name === wfName),
      `${wfName} should not appear in list after delete`,
    );
  });
});

describe("POST /api/workflows/save — validation", () => {
  it("rejects workflow with no stages and no steps", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/save", "POST", {
      name: `empty-stages-${Date.now()}`,
      workflow: {
        description: "Should be rejected",
        enabled: false,
        schedule: "",
        stages: [],
      },
    });
    assert.equal(status, 400, `expected 400 but got ${status}`);
    assert.equal(data.ok, false);
    assert.ok(
      data.error.toLowerCase().includes("stage") ||
        data.error.toLowerCase().includes("step"),
      `error message should mention stage or step, got: ${data.error}`,
    );
  });

  it("rejects workflow where stages have no agent/task (all filtered out)", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/save", "POST", {
      name: `bad-stages-${Date.now()}`,
      workflow: {
        description: "Bad stages",
        stages: [{ agent: "", task: "" }, { agent: "  ", task: "  " }],
      },
    });
    assert.equal(status, 400, `expected 400 (all stages filtered out), got ${status}`);
    assert.equal(data.ok, false);
  });

  it("rejects invalid workflow name", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/save", "POST", {
      name: "invalid name with spaces!",
      workflow: {
        stages: [{ agent: "crew-coder", task: "Test" }],
      },
    });
    assert.equal(status, 400, `expected 400 for invalid name, got ${status}`);
    assert.equal(data.ok, false);
  });

  it("rejects workflow with invalid cron expression", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/save", "POST", {
      name: `bad-cron-${Date.now()}`,
      workflow: {
        description: "Bad cron",
        schedule: "@daily",         // not a valid 5-field cron
        stages: [{ agent: "crew-coder", task: "Do work" }],
      },
    });
    assert.equal(status, 400, `expected 400 for invalid cron, got ${status}`);
    assert.equal(data.ok, false);
    assert.ok(
      data.error.toLowerCase().includes("cron") ||
        data.error.toLowerCase().includes("schedule"),
      `error should mention cron or schedule, got: ${data.error}`,
    );
  });

  it("rejects workflow with cron expression with wrong field count", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/save", "POST", {
      name: `bad-cron-fields-${Date.now()}`,
      workflow: {
        schedule: "0 9 *",          // only 3 fields
        stages: [{ agent: "crew-coder", task: "Do work" }],
      },
    });
    assert.equal(status, 400, `expected 400 for 3-field cron, got ${status}`);
    assert.equal(data.ok, false);
  });

  it("accepts workflow with valid 5-field cron expression", async (t) => {
    if (skipIfDown(t)) return;

    const name = `valid-cron-${Date.now()}`;
    const { status, data } = await api("/api/workflows/save", "POST", {
      name,
      workflow: {
        description: "Valid cron",
        enabled: false,
        schedule: "*/15 * * * *",
        stages: [{ agent: "crew-coder", task: "Scheduled task" }],
      },
    });
    assert.equal(status, 200, `expected 200 for valid cron, got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);

    // Cleanup.
    await api("/api/workflows/delete", "POST", { name }).catch(() => {});
  });
});

describe("GET /api/workflows/item — validation", () => {
  it("returns 400 for missing name parameter", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/item");
    assert.equal(status, 400);
    assert.equal(data.ok, false);
  });

  it("returns 400 for invalid workflow name", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/item?name=bad%20name!");
    assert.equal(status, 400);
    assert.equal(data.ok, false);
  });

  it("returns 404 for a workflow that does not exist", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api(
      `/api/workflows/item?name=nonexistent-wf-${Date.now()}`,
    );
    assert.equal(status, 404);
    assert.equal(data.ok, false);
  });
});

describe("POST /api/workflows/delete — validation", () => {
  it("returns 400 for invalid workflow name", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/delete", "POST", {
      name: "bad/name",
    });
    assert.equal(status, 400);
    assert.equal(data.ok, false);
  });

  it("succeeds even if the workflow file does not exist (idempotent)", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/delete", "POST", {
      name: `never-existed-${Date.now()}`,
    });
    // The server unlinks the file if it exists and returns ok:true either way.
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });
});

describe("GET /api/workflows/status — run state tracking", () => {
  it("returns ok:true with scheduler metadata and runs map", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/status");
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.ok(typeof data.runs === "object", "data.runs should be an object");
    assert.ok(typeof data.scheduler === "object", "data.scheduler should be an object");
    assert.equal(typeof data.scheduler.enabled, "boolean", "scheduler.enabled should be boolean");
    assert.equal(typeof data.scheduler.tickMs, "number", "scheduler.tickMs should be number");
    assert.equal(typeof data.scheduler.timezone, "string", "scheduler.timezone should be string");
  });
});

describe("POST /api/workflows/run — run state basics", () => {
  it("returns 400 with ok:false for an invalid workflow name", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/run", "POST", {
      name: "bad name!",
    });
    // Invalid name or non-existent workflow — server returns 400.
    assert.ok(
      status === 400 || status === 500,
      `expected 400 or 500 for invalid name, got ${status}`,
    );
    assert.equal(data.ok, false);
  });

  it("returns 400 with ok:false when workflow does not exist", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/run", "POST", {
      name: `no-such-workflow-${Date.now()}`,
    });
    assert.ok(
      status === 400 || status === 404 || status === 500,
      `expected 4xx or 500, got ${status}`,
    );
    assert.equal(data.ok, false);
  });
});

describe("GET /api/workflows/log — log endpoint basics", () => {
  it("returns ok:true with empty lines array for unknown workflow", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api(
      `/api/workflows/log?name=no-log-yet-${Date.now()}`,
    );
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.lines), "data.lines should be an array");
  });

  it("returns 400 for invalid workflow name", async (t) => {
    if (skipIfDown(t)) return;

    const { status, data } = await api("/api/workflows/log?name=bad%20name!");
    assert.equal(status, 400);
    assert.equal(data.ok, false);
  });
});
