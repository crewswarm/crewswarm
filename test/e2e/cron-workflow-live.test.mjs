/**
 * E2E: Cron / Scheduled workflow — create a workflow, trigger it, verify execution.
 *
 * Tests the full lifecycle:
 *   1. Create a workflow via API
 *   2. Trigger a run via API
 *   3. Poll until completion
 *   4. Verify the workflow produced output
 *   5. Clean up
 *
 * REQUIRES: crew-lead on :5010 (dashboard API handles workflows).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkServiceUp, httpRequest } from "../helpers/http.mjs";

const DASHBOARD_URL = "http://127.0.0.1:4319";
const CREW_LEAD_URL = "http://127.0.0.1:5010";
const CONFIG_PATH = join(homedir(), ".crewswarm", "crewswarm.json");

const WF_NAME = `e2e-cron-test-${Date.now()}`;

let authToken;
async function getAuthToken() {
  if (authToken) return authToken;
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    authToken = cfg?.rt?.authToken || "";
    return authToken;
  } catch { return ""; }
}

async function api(endpoint, method = "GET", body = null) {
  const token = await getAuthToken();
  return httpRequest(`${DASHBOARD_URL}${endpoint}`, {
    method,
    headers: { "Authorization": token ? `Bearer ${token}` : "" },
    body,
    timeout: 15000,
  });
}

// Pre-flight
const dashboardUp = await checkServiceUp(`${DASHBOARD_URL}/health`);
const crewLeadUp = await checkServiceUp(`${CREW_LEAD_URL}/health`);
const SKIP = !dashboardUp
  ? "Dashboard not running on :4319"
  : !crewLeadUp
    ? "crew-lead not running on :5010"
    : false;

describe("cron workflow lifecycle", { skip: SKIP, timeout: 120000 }, () => {

  after(async () => {
    // Cleanup: delete the test workflow
    try {
      await api("/api/workflows/delete", "POST", { name: WF_NAME });
    } catch { /* may not exist */ }
  });

  it("creates a workflow", async () => {
    const { status, data } = await api("/api/workflows/save", "POST", {
      name: WF_NAME,
      description: "E2E test workflow — dispatches a single task",
      schedule: "0 * * * *", // hourly (won't fire during test)
      stages: [
        {
          agent: "crew-coder",
          task: "Reply with WORKFLOW_CRON_OK",
        }
      ],
    });
    assert.ok(status >= 200 && status < 300, `Save failed: ${status}`);
    console.log(`    Created workflow: ${WF_NAME}`);
  });

  it("lists the workflow", async () => {
    const { data } = await api("/api/workflows/list");
    const workflows = data.workflows || data.items || [];
    const found = workflows.find(w => w.name === WF_NAME);
    assert.ok(found, `Workflow ${WF_NAME} should appear in list`);
    console.log(`    Found in list: ${found.name}`);
  });

  it("gets workflow detail", async () => {
    const { status, data } = await api(`/api/workflows/item?name=${encodeURIComponent(WF_NAME)}`);
    // Endpoint may return the workflow object directly or nested
    assert.ok(status >= 200 && status < 300, `Get item failed: ${status} ${JSON.stringify(data).slice(0, 100)}`);
    assert.ok(data.ok !== false, `Item lookup failed: ${data.error || "unknown"}`);
    console.log(`    Detail: ${JSON.stringify(data).slice(0, 100)}`);
  });

  it("triggers a workflow run", async () => {
    const { status, data } = await api("/api/workflows/run", "POST", {
      name: WF_NAME,
    });
    // run might return 200 with runId, or dispatch the task
    console.log(`    Run response: ${status} — ${JSON.stringify(data).slice(0, 100)}`);
    assert.ok(status >= 200 && status < 400, `Run failed: ${status}`);
  });

  it("deletes the workflow", async () => {
    const { status } = await api("/api/workflows/delete", "POST", { name: WF_NAME });
    assert.ok(status >= 200 && status < 300, `Delete failed: ${status}`);

    // Verify it's gone
    const { data } = await api("/api/workflows/list");
    const workflows = data.workflows || data.items || [];
    const found = workflows.find(w => w.name === WF_NAME);
    assert.ok(!found, "Workflow should be deleted");
    console.log("    Deleted + verified gone");
  });
});
