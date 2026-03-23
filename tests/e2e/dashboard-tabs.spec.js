import { test, expect } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4319";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert the dashboard API is reachable before each test.
 * Uses a direct request (no browser page needed) to avoid spending browser
 * warm-up time waiting for a server that might be down.
 */
async function waitForDashboardHealth(page) {
  const response = await page.request.get(`${BASE_URL}/api/health`, {
    timeout: 10_000,
  });
  expect(response.ok()).toBeTruthy();
}

/**
 * Navigate to the dashboard root and wait for the sidebar to be present.
 * "networkidle" can stall when the dashboard long-polls, so we gate on a
 * reliable DOM landmark instead.
 */
async function openDashboard(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  // Sidebar nav must be rendered before any tab click
  await expect(page.locator("nav.sidebar")).toBeVisible({ timeout: 10_000 });
}

/**
 * Click a sidebar nav button and wait for its corresponding view to become
 * active (the JS framework adds the "active" class to the view div).
 */
async function openTab(page, navId, viewId) {
  await page.locator(`#${navId}`).click();
  await expect(page.locator(`#${viewId}`)).toHaveClass(/active/, {
    timeout: 10_000,
  });
}

async function disableDashboardSSE(page) {
  await page.addInitScript(() => {
    class MockEventSource {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
      }
      addEventListener() {}
      removeEventListener() {}
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = MockEventSource;
  });
}

// ---------------------------------------------------------------------------
// Suite: Services tab
// ---------------------------------------------------------------------------

test.describe("Services tab", () => {
  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await openDashboard(page);
  });

  test("navigates to Services tab and view becomes active", async ({
    page,
  }) => {
    await openTab(page, "navServices", "servicesView");
    await expect(page.locator("#servicesView")).toBeVisible();
  });

  test("service cards render inside #servicesGrid after API response", async ({
    page,
  }) => {
    // Intercept /api/services/status so the test is deterministic even when
    // some services are legitimately down in CI.
    await page.route("**/api/services/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "crew-lead",
            label: "crew-lead",
            description: "Crew-lead orchestrator",
            running: true,
            pid: 12345,
            optional: false,
            canRestart: true,
            port: 3000,
          },
          {
            id: "crew-pm",
            label: "crew-pm",
            description: "Project manager agent",
            running: false,
            optional: true,
            canRestart: true,
          },
        ]),
      });
    });

    await openTab(page, "navServices", "servicesView");

    // Grid must contain at least one card
    const grid = page.locator("#servicesGrid");
    await expect(grid).toBeVisible({ timeout: 8_000 });
    await expect(grid.locator(".card")).toHaveCount(2, { timeout: 8_000 });
  });

  test("service cards show status text (running / stopped)", async ({
    page,
  }) => {
    await page.route("**/api/services/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "crew-lead",
            label: "crew-lead",
            description: "Orchestrator",
            running: true,
            pid: 99,
            optional: false,
            canRestart: true,
          },
        ]),
      });
    });

    await openTab(page, "navServices", "servicesView");

    // The status span uses CSS color via statusColor variable; check the text
    // The rendered status text is "● running  pid <pid>" or "● running"
    const grid = page.locator("#servicesGrid");
    await expect(grid).toContainText("● running", { timeout: 8_000 });
  });

  test("crew-lead card shows as running when API reports it running", async ({
    page,
  }) => {
    await page.route("**/api/services/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "crew-lead",
            label: "crew-lead",
            description: "Orchestrator",
            running: true,
            pid: 42,
            optional: false,
            canRestart: true,
          },
        ]),
      });
    });

    await openTab(page, "navServices", "servicesView");

    const grid = page.locator("#servicesGrid");
    // Card label
    await expect(grid).toContainText("crew-lead", { timeout: 8_000 });
    // Running status indicator
    await expect(grid).toContainText("● running", { timeout: 8_000 });
  });

  test("stopped required service shows servicesBadge with count", async ({
    page,
  }) => {
    await page.route("**/api/services/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "crew-lead",
            label: "crew-lead",
            description: "Orchestrator",
            running: false,
            optional: false,
            canRestart: true,
          },
        ]),
      });
    });

    await openTab(page, "navServices", "servicesView");

    // The badge count should be visible (1 required service down)
    const badge = page.locator("#servicesBadge");
    await expect(badge).not.toHaveClass(/hidden/, { timeout: 8_000 });
    await expect(badge).toContainText("1");
  });
});

// ---------------------------------------------------------------------------
// Suite: Engines tab
// ---------------------------------------------------------------------------

test.describe("Engines tab", () => {
  // Stable API fixture — one ready engine with envToggle, one not-installed
  const ENGINES_FIXTURE = {
    engines: [
      {
        id: "cursor",
        label: "Cursor",
        description: "AI code editor",
        ready: true,
        installed: true,
        requiresAuth: false,
        enabled: false,
        envToggle: "USE_CURSOR",
        traits: ["streaming", "diff-mode"],
        docsUrl: "https://cursor.sh",
        source: "builtin",
      },
      {
        id: "opencode",
        label: "OpenCode",
        description: "Open-source coding engine",
        ready: false,
        installed: false,
        requiresAuth: false,
        installCmd: "npm install -g opencode",
        traits: [],
        source: "builtin",
      },
    ],
  };

  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await page.route("**/api/engines", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ENGINES_FIXTURE),
      });
    });
    await openDashboard(page);
  });

  test("navigates to Engines tab and view becomes active", async ({ page }) => {
    await openTab(page, "navEngines", "enginesView");
    await expect(page.locator("#enginesView")).toBeVisible();
  });

  test("engine cards render in #enginesGrid", async ({ page }) => {
    await openTab(page, "navEngines", "enginesView");

    const grid = page.locator("#enginesGrid");
    await expect(grid).toBeVisible({ timeout: 8_000 });
    // Two engines in the fixture → two cards
    await expect(grid.locator(".card")).toHaveCount(2, { timeout: 8_000 });
  });

  test("engine card shows engine label and status dot", async ({ page }) => {
    await openTab(page, "navEngines", "enginesView");

    const grid = page.locator("#enginesGrid");
    await expect(grid).toContainText("Cursor", { timeout: 8_000 });
    await expect(grid).toContainText("Ready", { timeout: 8_000 });
    await expect(grid).toContainText("OpenCode", { timeout: 8_000 });
    await expect(grid).toContainText("Not installed", { timeout: 8_000 });
  });

  test("enable/disable toggle checkbox exists for ready engine with envToggle", async ({
    page,
  }) => {
    await openTab(page, "navEngines", "enginesView");

    // The toggle is rendered only when eng.envToggle && eng.ready
    const toggle = page.locator("#toggle-cursor");
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveAttribute("type", "checkbox");
  });

  test("clicking engine toggle calls POST /api/engines/toggle with correct payload", async ({
    page,
  }) => {
    // Intercept the toggle request before navigating
    const toggleRequests = [];
    await page.route("**/api/engines/toggle", async (route) => {
      const body = route.request().postDataJSON();
      toggleRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navEngines", "enginesView");

    const toggle = page.locator("#toggle-cursor");
    await expect(toggle).toBeVisible({ timeout: 8_000 });

    // Click the label/checkbox to trigger onchange → toggleEngineGlobal
    await toggle.click();

    // Wait for the intercepted request to arrive
    await page.waitForTimeout(500);

    expect(toggleRequests.length).toBeGreaterThanOrEqual(1);
    const payload = toggleRequests[0];
    expect(payload).toHaveProperty("engineId", "cursor");
    // After clicking an unchecked box it becomes checked → enabled: true
    expect(payload).toHaveProperty("enabled");
  });

  test("toggle checkbox is unchecked initially when engine.enabled is false", async ({
    page,
  }) => {
    await openTab(page, "navEngines", "enginesView");

    const toggle = page.locator("#toggle-cursor");
    await expect(toggle).not.toBeChecked({ timeout: 8_000 });
  });

  test("clicking toggle changes its checked state", async ({ page }) => {
    await page.route("**/api/engines/toggle", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navEngines", "enginesView");

    const toggle = page.locator("#toggle-cursor");
    await expect(toggle).not.toBeChecked({ timeout: 8_000 });
    await toggle.click();
    await expect(toggle).toBeChecked({ timeout: 4_000 });
  });

  test("engine without envToggle does not render a toggle checkbox", async ({
    page,
  }) => {
    await openTab(page, "navEngines", "enginesView");

    // opencode is not installed / not ready → no toggle
    const toggle = page.locator("#toggle-opencode");
    await expect(toggle).not.toBeVisible({ timeout: 4_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Workflows tab
// ---------------------------------------------------------------------------

test.describe("Workflows tab", () => {
  const WORKFLOWS_FIXTURE = {
    workflows: [
      {
        name: "daily-research",
        description: "Weekday research brief",
        enabled: true,
        schedule: "0 9 * * 1-5",
        stageCount: 3,
        runState: { running: false },
      },
      {
        name: "seo-content",
        description: "SEO content pipeline",
        enabled: false,
        schedule: "30 10 * * 1,3,5",
        stageCount: 3,
        runState: { running: false },
      },
    ],
    timezone: "America/Los_Angeles",
  };

  const WORKFLOW_ITEM_FIXTURE = {
    workflow: {
      description: "Weekday research brief",
      enabled: true,
      schedule: "0 9 * * 1-5",
      stages: [
        { agent: "crew-researcher", task: "Research and summarize." },
        { agent: "crew-pm", task: "Create daily brief." },
        { agent: "crew-qa", task: "Review the brief." },
      ],
    },
    runState: { running: false },
  };

  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    // Stub all supporting API calls the tab triggers on load
    await page.route("**/api/workflows/list", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(WORKFLOWS_FIXTURE),
      });
    });
    await page.route("**/api/agents", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(["crew-main", "crew-pm", "crew-qa"]),
      });
    });
    await page.route("**/api/skills", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ skills: [] }),
      });
    });

    await openDashboard(page);
  });

  test("navigates to Workflows tab and view becomes active", async ({
    page,
  }) => {
    await openTab(page, "navWorkflows", "workflowsView");
    await expect(page.locator("#workflowsView")).toBeVisible();
  });

  test("workflow list renders saved workflows from API", async ({ page }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const list = page.locator("#workflowList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    // Both fixture workflows should appear
    await expect(list).toContainText("daily-research", { timeout: 8_000 });
    await expect(list).toContainText("seo-content", { timeout: 8_000 });
  });

  test("workflow list shows enabled/disabled state and stage count", async ({
    page,
  }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const list = page.locator("#workflowList");
    await expect(list).toContainText("enabled", { timeout: 8_000 });
    await expect(list).toContainText("disabled", { timeout: 8_000 });
    await expect(list).toContainText("3 stage(s)", { timeout: 8_000 });
  });

  test("workflow list shows cron schedule", async ({ page }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const list = page.locator("#workflowList");
    await expect(list).toContainText("0 9 * * 1-5", { timeout: 8_000 });
  });

  test("clicking a workflow row loads its details in the editor", async ({
    page,
  }) => {
    await page.route(
      "**/api/workflows/item?name=daily-research",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(WORKFLOW_ITEM_FIXTURE),
        });
      },
    );
    // Stub the log endpoint that fires after item load
    await page.route("**/api/workflows/log**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ lines: [] }),
      });
    });

    await openTab(page, "navWorkflows", "workflowsView");

    // Click the first workflow row
    const workflowRow = page
      .locator('.workflow-row[data-workflow-name="daily-research"]')
      .first();
    await expect(workflowRow).toBeVisible({ timeout: 8_000 });
    await workflowRow.click();

    // After clicking, the editor should be populated with the workflow name
    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });
    // The wfName input should hold the name of the selected workflow
    await expect(editor.locator("#wfName")).toHaveValue("daily-research", {
      timeout: 8_000,
    });
  });

  test("New button clears the workflow editor to an empty state", async ({
    page,
  }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });

    const newBtn = editor.locator("#wfNewBtn");
    await expect(newBtn).toBeVisible({ timeout: 8_000 });
    await newBtn.click();

    // Name field should be empty
    await expect(editor.locator("#wfName")).toHaveValue("", { timeout: 4_000 });
  });

  test("workflow editor renders Save, Run, Delete, and New buttons", async ({
    page,
  }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });

    await expect(editor.locator("#wfSaveBtn")).toBeVisible({ timeout: 8_000 });
    await expect(editor.locator("#wfRunBtn")).toBeVisible({ timeout: 8_000 });
    await expect(editor.locator("#wfDeleteBtn")).toBeVisible({
      timeout: 8_000,
    });
    await expect(editor.locator("#wfNewBtn")).toBeVisible({ timeout: 8_000 });
  });

  test("Add Stage button appends a new stage row to the editor", async ({
    page,
  }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });

    // Initial empty workflow renders 1 stage row
    const addStageBtn = editor.locator("#wfAddStageBtn");
    await expect(addStageBtn).toBeVisible({ timeout: 8_000 });

    const stagesBefore = await editor.locator(".wf-stage-row").count();
    await addStageBtn.click();
    const stagesAfter = await editor.locator(".wf-stage-row").count();

    expect(stagesAfter).toBe(stagesBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Suite: Workflow Run button
// ---------------------------------------------------------------------------

test.describe("Workflow run wiring", () => {
  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/workflows/list", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workflows: [
            {
              name: "test-workflow",
              description: "A test workflow",
              enabled: true,
              schedule: "0 9 * * *",
              stageCount: 1,
              runState: { running: false },
            },
          ],
          timezone: "UTC",
        }),
      });
    });
    await page.route("**/api/agents", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(["crew-main"]),
      });
    });
    await page.route("**/api/skills", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ skills: [] }),
      });
    });

    await openDashboard(page);
  });

  test("Run Now button exists in workflow editor", async ({ page }) => {
    await openTab(page, "navWorkflows", "workflowsView");

    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });

    const runBtn = editor.locator("#wfRunBtn");
    await expect(runBtn).toBeVisible({ timeout: 8_000 });
    await expect(runBtn).toContainText("Run Now");
  });

  test("Run Now button posts to POST /api/workflows/run", async ({ page }) => {
    const runRequests = [];

    await page.route("**/api/workflows/run", async (route) => {
      const body = route.request().postDataJSON();
      runRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, pid: 7777 }),
      });
    });
    // Log and item endpoints triggered after a run
    await page.route("**/api/workflows/item**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workflow: {
            description: "",
            enabled: true,
            schedule: "0 9 * * *",
            stages: [{ agent: "crew-main", task: "Do something." }],
          },
          runState: { running: false },
        }),
      });
    });
    await page.route("**/api/workflows/log**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ lines: [] }),
      });
    });

    await openTab(page, "navWorkflows", "workflowsView");

    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });

    // Fill in a workflow name (required for the run to proceed)
    const nameInput = editor.locator("#wfName");
    await expect(nameInput).toBeVisible({ timeout: 8_000 });
    await nameInput.fill("test-workflow");

    // Fill the required task field so collectWorkflowFromForm has a valid stage
    const taskField = editor.locator(".wf-task").first();
    await expect(taskField).toBeVisible({ timeout: 8_000 });
    await taskField.fill("Do something.");

    const runBtn = editor.locator("#wfRunBtn");
    await expect(runBtn).toBeVisible({ timeout: 8_000 });
    await runBtn.click();

    // Wait for the request handler to fire
    await page.waitForTimeout(1_000);

    expect(runRequests.length).toBe(1);
    expect(runRequests[0]).toHaveProperty("name", "test-workflow");
  });

  test("Run Now without a name does not call /api/workflows/run", async ({
    page,
  }) => {
    const runRequests = [];
    await page.route("**/api/workflows/run", async (route) => {
      runRequests.push(true);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navWorkflows", "workflowsView");

    const editor = page.locator("#workflowEditor");
    await expect(editor).toBeVisible({ timeout: 8_000 });

    // Ensure name input is empty
    const nameInput = editor.locator("#wfName");
    await nameInput.fill("");

    const runBtn = editor.locator("#wfRunBtn");
    await runBtn.click();

    // A brief settle period — no request should arrive
    await page.waitForTimeout(600);
    expect(runRequests.length).toBe(0);
  });
});
