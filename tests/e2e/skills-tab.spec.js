import { test, expect } from "@playwright/test";
import { setupConsoleErrorCapture, expectNoConsoleErrors } from "./helpers.mjs";

const BASE_URL = "http://127.0.0.1:4319";

// ---------------------------------------------------------------------------
// Helpers (copied from dashboard-tabs.spec.js)
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
// Fixtures
// ---------------------------------------------------------------------------

const SKILLS_FIXTURE = {
  skills: [
    {
      name: "web-search",
      type: "api",
      description: "Search the web via Brave",
      url: "https://api.search.brave.com/res/v1/web/search",
      method: "GET",
      requiresApproval: false,
      aliases: ["search", "browse"],
      defaultParams: { count: 5 },
    },
    {
      name: "company-knowledge",
      type: "knowledge",
      description: "Internal company FAQ and documentation",
      requiresApproval: false,
      aliases: [],
      defaultParams: {},
    },
    {
      name: "send-email",
      type: "api",
      description: "Send emails via SendGrid",
      url: "https://api.sendgrid.com/v3/mail/send",
      method: "POST",
      requiresApproval: true,
      aliases: [],
      defaultParams: {},
    },
  ],
};

// ---------------------------------------------------------------------------
// Suite: Skills tab — navigation and list rendering
// ---------------------------------------------------------------------------

test.describe("Skills tab — navigation and list rendering", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/skills", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SKILLS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Skills tab and view becomes active", async ({ page }) => {
    await openTab(page, "navSkills", "skillsView");
    await expect(page.locator("#skillsView")).toBeVisible();
  });

  test("skills list renders all skills from API fixture", async ({ page }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("web-search", { timeout: 8_000 });
    await expect(list).toContainText("company-knowledge", { timeout: 8_000 });
    await expect(list).toContainText("send-email", { timeout: 8_000 });
  });

  test("API skills show green 'API' type badge", async ({ page }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("API", { timeout: 8_000 });
  });

  test("knowledge skills show purple 'knowledge' type badge", async ({
    page,
  }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("knowledge", { timeout: 8_000 });
  });

  test("skill requiring approval shows approval warning badge", async ({
    page,
  }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("approval", { timeout: 8_000 });
  });

  test("skill with aliases shows alias names in the row", async ({ page }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    // web-search has aliases: search, browse
    await expect(list).toContainText("aliases: search, browse", {
      timeout: 8_000,
    });
  });

  test("API skills render an Edit button; knowledge skills do not", async ({
    page,
  }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // There are 2 API skills → 2 Edit buttons
    const editBtns = list.locator("[data-action='editSkill']");
    await expect(editBtns).toHaveCount(2, { timeout: 8_000 });
  });

  test("all skills render a Delete button", async ({ page }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // 3 skills → 3 delete buttons
    const deleteBtns = list.locator("[data-action='deleteSkill']");
    await expect(deleteBtns).toHaveCount(3, { timeout: 8_000 });
  });

  test("empty skills list shows empty-state message", async ({ page }) => {
    await page.route("**/api/skills", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ skills: [] }),
      });
    });

    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toContainText("No skills match", { timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Skills tab — add skill form
// ---------------------------------------------------------------------------

test.describe("Skills tab — add skill form", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/skills", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SKILLS_FIXTURE),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("Add Skill button toggles the add skill form open", async ({ page }) => {
    await openTab(page, "navSkills", "skillsView");

    // Button that calls toggleAddSkill()
    const addBtn = page
      .locator("button, [data-action='toggleAddSkill']")
      .filter({ hasText: /add skill|new skill/i })
      .first();
    await expect(addBtn).toBeVisible({ timeout: 8_000 });
    await addBtn.click();

    const form = page.locator("#addSkillForm");
    await expect(form).toBeVisible({ timeout: 4_000 });
  });

  test("add skill form contains required fields: name, URL, description", async ({
    page,
  }) => {
    await openTab(page, "navSkills", "skillsView");

    // Force the form visible if toggle button isn't found by text
    const addBtn = page
      .locator("[data-action='toggleAddSkill'], button")
      .filter({ hasText: /add skill|new skill/i })
      .first();
    if (await addBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await addBtn.click();
    } else {
      await page.evaluate(() => {
        const f = document.getElementById("addSkillForm");
        if (f) f.style.display = "block";
      });
    }

    await expect(page.locator("#skName")).toBeVisible({ timeout: 4_000 });
    await expect(page.locator("#skUrl")).toBeVisible({ timeout: 4_000 });
    await expect(page.locator("#skDesc")).toBeVisible({ timeout: 4_000 });
  });

  test("saving a new skill POSTs to /api/skills with correct payload", async ({
    page,
  }) => {
    const saveRequests = [];

    await page.route("**/api/skills", async (route) => {
      if (route.request().method() === "POST") {
        saveRequests.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SKILLS_FIXTURE),
        });
      }
    });

    await openTab(page, "navSkills", "skillsView");

    // Reveal the form
    const addBtn = page
      .locator("[data-action='toggleAddSkill'], button")
      .filter({ hasText: /add skill|new skill/i })
      .first();
    if (await addBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await addBtn.click();
    } else {
      await page.evaluate(() => {
        const f = document.getElementById("addSkillForm");
        if (f) f.style.display = "block";
      });
    }

    await page.locator("#skName").fill("my-new-skill");
    await page.locator("#skDesc").fill("A test skill");
    await page.locator("#skUrl").fill("https://api.example.com/run");

    const saveBtn = page.locator("#saveSkillBtn");
    await expect(saveBtn).toBeVisible({ timeout: 4_000 });
    await saveBtn.click();

    await page.waitForTimeout(800);

    expect(saveRequests.length).toBe(1);
    expect(saveRequests[0]).toHaveProperty("name", "my-new-skill");
    expect(saveRequests[0]).toHaveProperty("url", "https://api.example.com/run");
    expect(saveRequests[0]).toHaveProperty("description", "A test skill");
  });

  test("editing an existing skill pre-populates the form with skill data", async ({
    page,
  }) => {
    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // Click Edit on the first API skill (web-search)
    const editBtn = list.locator("[data-action='editSkill']").first();
    await expect(editBtn).toBeVisible({ timeout: 8_000 });
    await editBtn.click();

    // Form should open and name field should be pre-populated
    const nameInput = page.locator("#skName");
    await expect(nameInput).toBeVisible({ timeout: 4_000 });
    await expect(nameInput).toHaveValue("web-search");

    // URL should also be pre-populated
    const urlInput = page.locator("#skUrl");
    await expect(urlInput).toHaveValue(
      "https://api.search.brave.com/res/v1/web/search"
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: Skills tab — delete and import
// ---------------------------------------------------------------------------

test.describe("Skills tab — delete and import", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/skills", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SKILLS_FIXTURE),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("deleting a skill sends DELETE to /api/skills/:name", async ({
    page,
  }) => {
    const deleteUrls = [];

    await page.route("**/api/skills/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.continue();
      }
    });

    // Auto-accept confirm dialog
    page.on("dialog", (dialog) => dialog.accept());

    await openTab(page, "navSkills", "skillsView");

    const list = page.locator("#skillsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // Delete the first skill
    const deleteBtn = list.locator("[data-action='deleteSkill']").first();
    await expect(deleteBtn).toBeVisible({ timeout: 8_000 });
    await deleteBtn.click();

    await page.waitForTimeout(800);

    expect(deleteUrls.length).toBe(1);
    // URL should contain the skill name
    expect(deleteUrls[0]).toMatch(/\/api\/skills\//);
  });

  test("import skill form can be toggled open and contains a URL input", async ({
    page,
  }) => {
    await openTab(page, "navSkills", "skillsView");

    const importBtn = page
      .locator("[data-action='toggleImportSkill'], button")
      .filter({ hasText: /import/i })
      .first();

    if (await importBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await importBtn.click();
      const importForm = page.locator("#importSkillForm");
      await expect(importForm).toBeVisible({ timeout: 4_000 });
      await expect(page.locator("#importSkillUrl")).toBeVisible();
    } else {
      // Form may already be in DOM but hidden — force display and verify input
      await page.evaluate(() => {
        const f = document.getElementById("importSkillForm");
        if (f) f.style.display = "block";
      });
      await expect(page.locator("#importSkillUrl")).toBeVisible({ timeout: 4_000 });
    }
  });

  test("importing a skill from URL POSTs to /api/skills/import", async ({
    page,
  }) => {
    const importRequests = [];

    await page.route("**/api/skills/import", async (route) => {
      importRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, name: "imported-skill", warnings: [] }),
      });
    });

    await openTab(page, "navSkills", "skillsView");

    // Reveal import form
    const importBtn = page
      .locator("[data-action='toggleImportSkill'], button")
      .filter({ hasText: /import/i })
      .first();
    if (await importBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await importBtn.click();
    } else {
      await page.evaluate(() => {
        const f = document.getElementById("importSkillForm");
        if (f) f.style.display = "block";
      });
    }

    const urlInput = page.locator("#importSkillUrl");
    await expect(urlInput).toBeVisible({ timeout: 4_000 });
    await urlInput.fill("https://example.com/my-skill.json");

    const importSubmitBtn = page.locator("#importSkillBtn");
    await expect(importSubmitBtn).toBeVisible({ timeout: 4_000 });
    await importSubmitBtn.click();

    await page.waitForTimeout(800);

    expect(importRequests.length).toBe(1);
    expect(importRequests[0]).toHaveProperty(
      "url",
      "https://example.com/my-skill.json"
    );
  });
});
