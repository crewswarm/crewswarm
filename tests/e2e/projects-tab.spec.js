import { test, expect } from "@playwright/test";
import { setupConsoleErrorCapture, expectNoConsoleErrors } from "./helpers.mjs";

const BASE_URL = "http://127.0.0.1:4319";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForDashboardHealth(page) {
  const response = await page.request.get(`${BASE_URL}/api/health`, {
    timeout: 10_000,
  });
  expect(response.ok()).toBeTruthy();
}

async function openDashboard(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await expect(page.locator("nav.sidebar")).toBeVisible({ timeout: 10_000 });
}

async function openTab(page, navId, viewId) {
  await page.locator(`#${navId}`).click();
  await page.waitForTimeout(500);
  const isActive = await page
    .locator(`#${viewId}`)
    .evaluate(
      (el) => el.classList.contains("active") || el.style.display !== "none"
    )
    .catch(() => false);
  if (!isActive) {
    const dataView = await page
      .locator(`#${navId}`)
      .getAttribute("data-view");
    if (dataView)
      await page.evaluate((v) => {
        window.location.hash = v;
      }, dataView);
    await page.waitForTimeout(500);
  }
  await expect(page.locator(`#${viewId}`)).toBeVisible({ timeout: 10_000 });
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
// Fixture
// ---------------------------------------------------------------------------

const PROJECTS_FIXTURE = {
  projects: [
    {
      id: "proj-alpha",
      name: "Alpha Project",
      description: "The first test project",
      status: "active",
      running: false,
      autoAdvance: false,
      outputDir: "/tmp/alpha",
      roadmapFile: "/tmp/alpha/ROADMAP.md",
      created: new Date("2026-01-15").toISOString(),
      roadmap: { total: 10, done: 6, failed: 0, pending: 4 },
    },
    {
      id: "proj-beta",
      name: "Beta Project",
      description: "The second test project",
      status: "paused",
      running: true,
      autoAdvance: true,
      outputDir: "/tmp/beta",
      roadmapFile: "/tmp/beta/ROADMAP.md",
      created: new Date("2026-02-01").toISOString(),
      roadmap: { total: 5, done: 5, failed: 2, pending: 0 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Suite: Projects tab
// ---------------------------------------------------------------------------

test.describe("Projects tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/projects", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROJECTS_FIXTURE),
      });
    });

    // Stub supporting endpoints triggered on load
    await page.route("**/api/ui/active-project", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Projects tab and view becomes active", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");
    await expect(page.locator("#projectsView")).toBeVisible();
  });

  test("project cards render inside #projectsList after API response", async ({
    page,
  }) => {
    await openTab(page, "navProjects", "projectsView");

    const list = page.locator("#projectsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    // Two projects in fixture — two cards
    await expect(list.locator(".card")).toHaveCount(2, { timeout: 8_000 });
  });

  test("project cards show project name and status badge", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    const list = page.locator("#projectsList");
    await expect(list).toContainText("Alpha Project", { timeout: 8_000 });
    await expect(list).toContainText("Beta Project", { timeout: 8_000 });
    await expect(list).toContainText("active", { timeout: 8_000 });
    await expect(list).toContainText("paused", { timeout: 8_000 });
  });

  test("running project shows running indicator", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    // proj-beta has running: true
    const list = page.locator("#projectsList");
    await expect(list).toContainText("▶ running", { timeout: 8_000 });
  });

  test("roadmap progress bar renders with done/total text", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    const list = page.locator("#projectsList");
    // Alpha: 6/10 done
    await expect(list).toContainText("6/10 done", { timeout: 8_000 });
    // Beta: 5/5 done, 2 failed
    await expect(list).toContainText("5/5 done", { timeout: 8_000 });
    await expect(list).toContainText("2 failed", { timeout: 8_000 });
  });

  test("PM loop Start button exists for non-running project", async ({
    page,
  }) => {
    await openTab(page, "navProjects", "projectsView");

    // proj-alpha is not running → should have Start PM Loop button
    const card = page.locator("#proj-card-proj-alpha");
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(card.locator('[data-action="pm-toggle"]')).toContainText(
      "Start PM Loop",
      { timeout: 8_000 }
    );
  });

  test("PM loop Stop button exists for running project", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    // proj-beta is running → should have Stop PM Loop button
    const card = page.locator("#proj-card-proj-beta");
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(card.locator('[data-action="pm-toggle"]')).toContainText(
      "Stop PM Loop",
      { timeout: 8_000 }
    );
  });

  test("clicking Start PM Loop calls POST /api/pm-loop/start", async ({
    page,
  }) => {
    const startRequests = [];
    await page.route("**/api/pm-loop/start", async (route) => {
      const body = route.request().postDataJSON();
      startRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, pid: 9999 }),
      });
    });

    await openTab(page, "navProjects", "projectsView");

    const card = page.locator("#proj-card-proj-alpha");
    await expect(card).toBeVisible({ timeout: 8_000 });

    const startBtn = card.locator('[data-action="pm-toggle"]');
    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await startBtn.click();

    await page.waitForTimeout(500);

    expect(startRequests.length).toBeGreaterThanOrEqual(1);
    expect(startRequests[0]).toHaveProperty("projectId", "proj-alpha");
  });

  test("clicking edit button reveals inline edit form", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    const card = page.locator("#proj-card-proj-alpha");
    await expect(card).toBeVisible({ timeout: 8_000 });

    const editBtn = card.locator('[data-action="edit"]');
    await expect(editBtn).toBeVisible({ timeout: 8_000 });
    await editBtn.click();

    // Edit form should become visible
    const editForm = page.locator("#proj-edit-proj-alpha");
    await expect(editForm).toBeVisible({ timeout: 4_000 });

    // Name field should be pre-filled with project name
    const nameInput = page.locator("#proj-name-proj-alpha");
    await expect(nameInput).toHaveValue("Alpha Project", { timeout: 4_000 });
  });

  test("save edit calls POST /api/projects/update with updated fields", async ({
    page,
  }) => {
    const updateRequests = [];
    await page.route("**/api/projects/update", async (route) => {
      const body = route.request().postDataJSON();
      updateRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navProjects", "projectsView");

    // Open edit form
    const editBtn = page.locator("#proj-card-proj-alpha").locator('[data-action="edit"]');
    await editBtn.click();
    await expect(page.locator("#proj-edit-proj-alpha")).toBeVisible({ timeout: 4_000 });

    // Change the name
    const nameInput = page.locator("#proj-name-proj-alpha");
    await nameInput.fill("Alpha Project Renamed");

    // Click Save
    const saveBtn = page.locator('[data-action="save-project-edit"][data-id="proj-alpha"]');
    await saveBtn.click();

    await page.waitForTimeout(600);

    expect(updateRequests.length).toBeGreaterThanOrEqual(1);
    expect(updateRequests[0]).toHaveProperty("projectId", "proj-alpha");
    expect(updateRequests[0]).toHaveProperty("name", "Alpha Project Renamed");
  });

  test("cancel edit hides the edit form", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    const card = page.locator("#proj-card-proj-alpha");
    const editBtn = card.locator('[data-action="edit"]');
    await editBtn.click();

    const editForm = page.locator("#proj-edit-proj-alpha");
    await expect(editForm).toBeVisible({ timeout: 4_000 });

    const cancelBtn = page.locator('[data-action="cancel-project-edit"][data-id="proj-alpha"]');
    await cancelBtn.click();

    await expect(editForm).not.toBeVisible({ timeout: 4_000 });
  });

  test("delete button triggers confirmation and calls POST /api/projects/delete on confirm", async ({
    page,
  }) => {
    const deleteRequests = [];
    await page.route("**/api/projects/delete", async (route) => {
      const body = route.request().postDataJSON();
      deleteRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Accept the confirm() dialog automatically
    page.on("dialog", (dialog) => dialog.accept());

    await openTab(page, "navProjects", "projectsView");

    const card = page.locator("#proj-card-proj-alpha");
    const deleteBtn = card.locator('[data-action="delete"]');
    await expect(deleteBtn).toBeVisible({ timeout: 8_000 });
    await deleteBtn.click();

    await page.waitForTimeout(600);

    expect(deleteRequests.length).toBe(1);
    expect(deleteRequests[0]).toHaveProperty("projectId", "proj-alpha");
  });

  test("auto-advance checkbox is checked for project with autoAdvance:true", async ({
    page,
  }) => {
    await openTab(page, "navProjects", "projectsView");

    // proj-beta has autoAdvance: true
    const card = page.locator("#proj-card-proj-beta");
    await expect(card).toBeVisible({ timeout: 8_000 });
    const autoAdvanceCheck = card.locator('[data-action="toggle-auto-advance"]');
    await expect(autoAdvanceCheck).toBeChecked({ timeout: 4_000 });
  });

  test("failed items retry button appears when roadmap has failures", async ({
    page,
  }) => {
    await openTab(page, "navProjects", "projectsView");

    // proj-beta has 2 failed items → retry button should appear
    const card = page.locator("#proj-card-proj-beta");
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(card.locator('[data-action="retry-failed"]')).toBeVisible({
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Suite: Projects tab — empty state
// ---------------------------------------------------------------------------

test.describe("Projects tab — empty state", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/projects", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ projects: [] }),
      });
    });
    await page.route("**/api/ui/active-project", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("shows empty state message when no projects exist", async ({ page }) => {
    await openTab(page, "navProjects", "projectsView");

    const list = page.locator("#projectsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("No projects yet", { timeout: 8_000 });
  });
});
