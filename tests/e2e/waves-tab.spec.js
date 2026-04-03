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

const WAVES_CONFIG_FIXTURE = {
  waves: [
    {
      id: 1,
      name: "Discovery",
      description: "Research and requirements gathering phase",
      agents: [
        {
          id: "crew-researcher",
          task: "[TASK] Research the topic thoroughly and produce a brief.",
        },
        {
          id: "crew-pm",
          task: "[TASK] Distill requirements from the research output.",
        },
      ],
    },
    {
      id: 2,
      name: "Implementation",
      description: "Build phase — all coding agents work in parallel",
      agents: [
        {
          id: "crew-coder-front",
          task: "[TASK] Implement the frontend changes.",
        },
        {
          id: "crew-main",
          task: "[TASK] Implement backend logic.",
        },
      ],
    },
    {
      id: 3,
      name: "Validation",
      description: "QA and security review",
      agents: [
        {
          id: "crew-qa",
          task: "[TASK] Run the full test suite and report failures.",
        },
        {
          id: "crew-security",
          task: "[TASK] Perform a security audit of the changes.",
        },
      ],
    },
  ],
  templates: {
    "full-stack": {
      name: "Full Stack App",
      description: "All three waves with front/back split",
      wave_overrides: {
        "2": {
          agents: [
            { id: "crew-coder-front", task: "[TASK] Build the UI." },
            { id: "crew-main", task: "[TASK] Build the API." },
          ],
        },
      },
    },
    "content-only": {
      name: "Content Pipeline",
      description: "Research then copywriter, skip implementation wave",
      wave_overrides: {
        "1": {
          agents: [
            {
              id: "crew-researcher",
              task: "[TASK] Research the subject matter.",
            },
          ],
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Suite: Waves tab
// ---------------------------------------------------------------------------

test.describe("Waves tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/waves/config", async (route) => {
      // Only respond to GET (not POST save)
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(WAVES_CONFIG_FIXTURE),
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

  test("navigates to Waves tab and wavesView becomes active", async ({
    page,
  }) => {
    await openTab(page, "navWaves", "wavesView");
    await expect(page.locator("#wavesView")).toBeVisible();
  });

  test("wave cards render for all three waves", async ({ page }) => {
    await openTab(page, "navWaves", "wavesView");

    const wavesList = page.locator("#waves-tab .waves-list");
    await expect(wavesList).toBeVisible({ timeout: 8_000 });
    await expect(wavesList.locator(".wave-card")).toHaveCount(3, {
      timeout: 8_000,
    });
  });

  test("wave cards display wave name and description", async ({ page }) => {
    await openTab(page, "navWaves", "wavesView");

    const wavesList = page.locator("#waves-tab .waves-list");
    await expect(wavesList).toBeVisible({ timeout: 8_000 });

    await expect(wavesList).toContainText("Discovery", { timeout: 8_000 });
    await expect(wavesList).toContainText(
      "Research and requirements gathering phase",
      { timeout: 8_000 }
    );
    await expect(wavesList).toContainText("Implementation", {
      timeout: 8_000,
    });
    await expect(wavesList).toContainText("Validation", { timeout: 8_000 });
  });

  test("wave cards display wave ID numbers", async ({ page }) => {
    await openTab(page, "navWaves", "wavesView");

    const wavesList = page.locator("#waves-tab .waves-list");
    await expect(wavesList).toBeVisible({ timeout: 8_000 });
    await expect(wavesList).toContainText("Wave 1", { timeout: 8_000 });
    await expect(wavesList).toContainText("Wave 2", { timeout: 8_000 });
    await expect(wavesList).toContainText("Wave 3", { timeout: 8_000 });
  });

  test("agent slots render with agent IDs for each wave", async ({ page }) => {
    await openTab(page, "navWaves", "wavesView");

    const wavesList = page.locator("#waves-tab .waves-list");
    await expect(wavesList).toBeVisible({ timeout: 8_000 });

    // Wave 1 agents
    const wave1 = page.locator('.wave-card[data-wave-id="1"]');
    await expect(wave1).toBeVisible({ timeout: 8_000 });
    await expect(wave1.locator(".agent-slot")).toHaveCount(2, {
      timeout: 8_000,
    });

    // Agent dropdowns should show the assigned agent
    const firstSelect = wave1.locator(".agent-select").first();
    await expect(firstSelect).toHaveValue("crew-researcher", {
      timeout: 8_000,
    });
  });

  test("agent task textarea shows existing task text", async ({ page }) => {
    await openTab(page, "navWaves", "wavesView");

    const wave1 = page.locator('.wave-card[data-wave-id="1"]');
    await expect(wave1).toBeVisible({ timeout: 8_000 });

    const firstTaskArea = wave1.locator(".agent-task").first();
    await expect(firstTaskArea).toBeVisible({ timeout: 8_000 });
    await expect(firstTaskArea).toHaveValue(
      /Research the topic thoroughly/,
      { timeout: 8_000 }
    );
  });

  test("Add Agent button appends a new agent slot to the wave", async ({
    page,
  }) => {
    await openTab(page, "navWaves", "wavesView");

    const wave1 = page.locator('.wave-card[data-wave-id="1"]');
    await expect(wave1).toBeVisible({ timeout: 8_000 });

    const addBtn = wave1.locator('.add-agent-btn[data-wave-id="1"]');
    await expect(addBtn).toBeVisible({ timeout: 8_000 });

    const slotsBefore = await wave1.locator(".agent-slot").count();
    await addBtn.click();
    await page.waitForTimeout(400);

    // Wave tab re-renders on add; count wave-1 slots again
    const wave1After = page.locator('.wave-card[data-wave-id="1"]');
    const slotsAfter = await wave1After.locator(".agent-slot").count();
    expect(slotsAfter).toBe(slotsBefore + 1);
  });

  test("Remove button removes an agent slot from the wave", async ({
    page,
  }) => {
    await openTab(page, "navWaves", "wavesView");

    const wave1 = page.locator('.wave-card[data-wave-id="1"]');
    await expect(wave1).toBeVisible({ timeout: 8_000 });

    const slotsBefore = await wave1.locator(".agent-slot").count();
    expect(slotsBefore).toBe(2);

    // Click remove on the first agent slot
    const removeBtn = wave1
      .locator('.remove-agent-btn[data-wave-id="1"]')
      .first();
    await expect(removeBtn).toBeVisible({ timeout: 8_000 });
    await removeBtn.click();
    await page.waitForTimeout(400);

    const wave1After = page.locator('.wave-card[data-wave-id="1"]');
    const slotsAfter = await wave1After.locator(".agent-slot").count();
    expect(slotsAfter).toBe(slotsBefore - 1);
  });

  test("Save Configuration button calls POST /api/waves/config", async ({
    page,
  }) => {
    const saveBodies = [];
    await page.route("**/api/waves/config", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        saveBodies.push(body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(WAVES_CONFIG_FIXTURE),
        });
      }
    });

    await openTab(page, "navWaves", "wavesView");

    const saveBtn = page.locator("#saveWavesBtn");
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await saveBtn.click();
    await page.waitForTimeout(600);

    expect(saveBodies.length).toBe(1);
    // Payload should contain the waves array
    expect(saveBodies[0]).toHaveProperty("waves");
    expect(Array.isArray(saveBodies[0].waves)).toBe(true);
    expect(saveBodies[0].waves.length).toBe(3);
  });

  test("Reset button calls POST /api/waves/config/reset on confirm", async ({
    page,
  }) => {
    const resetCalls = [];
    await page.route("**/api/waves/config/reset", async (route) => {
      resetCalls.push(true);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Accept the confirm dialog
    page.on("dialog", (dialog) => dialog.accept());

    await openTab(page, "navWaves", "wavesView");

    const resetBtn = page.locator("#resetWavesBtn");
    await expect(resetBtn).toBeVisible({ timeout: 8_000 });
    await resetBtn.click();
    await page.waitForTimeout(600);

    expect(resetCalls.length).toBe(1);
  });

  test("template buttons render for each configured template", async ({
    page,
  }) => {
    await openTab(page, "navWaves", "wavesView");

    const templateSection = page.locator("#waves-tab .wave-templates");
    await expect(templateSection).toBeVisible({ timeout: 8_000 });

    await expect(
      templateSection.locator('.template-btn[data-template="full-stack"]')
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      templateSection.locator('.template-btn[data-template="content-only"]')
    ).toBeVisible({ timeout: 8_000 });
  });

  test("clicking a template button applies overrides and re-renders waves", async ({
    page,
  }) => {
    await openTab(page, "navWaves", "wavesView");

    // Confirm the wave-2 first agent is 'crew-coder-front' before applying template
    const wave2Before = page.locator('.wave-card[data-wave-id="2"]');
    await expect(wave2Before).toBeVisible({ timeout: 8_000 });
    const selectBefore = wave2Before.locator(".agent-select").first();
    await expect(selectBefore).toHaveValue("crew-coder-front", {
      timeout: 8_000,
    });

    // Click the full-stack template
    const fullStackBtn = page.locator(
      '.template-btn[data-template="full-stack"]'
    );
    await expect(fullStackBtn).toBeVisible({ timeout: 8_000 });
    await fullStackBtn.click();
    await page.waitForTimeout(400);

    // After applying, wave-2 agents should reflect the template override
    const wave2After = page.locator('.wave-card[data-wave-id="2"]');
    await expect(wave2After).toBeVisible({ timeout: 4_000 });
    await expect(wave2After.locator(".agent-slot")).toHaveCount(2, {
      timeout: 4_000,
    });
  });

  test("changing agent dropdown updates the agent assignment", async ({
    page,
  }) => {
    await openTab(page, "navWaves", "wavesView");

    const wave3 = page.locator('.wave-card[data-wave-id="3"]');
    await expect(wave3).toBeVisible({ timeout: 8_000 });

    const qaSelect = wave3.locator(".agent-select").first();
    await expect(qaSelect).toBeVisible({ timeout: 8_000 });
    await expect(qaSelect).toHaveValue("crew-qa", { timeout: 8_000 });

    // Change to crew-main
    await qaSelect.selectOption("crew-main");
    await expect(qaSelect).toHaveValue("crew-main", { timeout: 4_000 });
  });
});
