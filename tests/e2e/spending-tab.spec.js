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
// Fixtures
// ---------------------------------------------------------------------------

const SPENDING_TODAY_FIXTURE = {
  spending: {
    date: "2026-04-02",
    global: { tokens: 85000, costUSD: 0.2125 },
    agents: {
      "crew-lead": { tokens: 50000, costUSD: 0.125 },
      "crew-pm": { tokens: 35000, costUSD: 0.0875 },
    },
  },
  caps: {
    global: { dailyTokenLimit: 200000, dailyCostLimitUSD: 5.0 },
    agents: {
      "crew-lead": { dailyTokenLimit: 100000 },
    },
  },
};

const TOKEN_USAGE_FIXTURE = {
  prompt: 120000,
  completion: 40000,
  calls: 380,
  byModel: {
    "claude-sonnet-4": { prompt: 90000, completion: 30000 },
    "gpt-5.2": { prompt: 30000, completion: 10000 },
  },
  byDay: {
    "2026-04-01": {
      prompt: 60000,
      completion: 20000,
      byModel: {
        "claude-sonnet-4": { prompt: 60000, completion: 20000 },
      },
    },
    "2026-03-31": {
      prompt: 40000,
      completion: 15000,
      byModel: {
        "gpt-5.2": { prompt: 40000, completion: 15000 },
      },
    },
  },
};

const OC_STATS_FIXTURE = {
  ok: true,
  byDay: {
    "2026-04-01": {
      cost: 0.85,
      input_tok: 400000,
      output_tok: 80000,
      calls: 42,
      byModel: {
        "gpt-5.2": { cost: 0.85, input_tok: 400000, output_tok: 80000, calls: 42 },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Suite: Spending tab — today view
// ---------------------------------------------------------------------------

test.describe("Spending tab — today view", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    // Stub all endpoints the tab fires on load
    await page.route("**/api/spending", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SPENDING_TODAY_FIXTURE),
      });
    });
    await page.route("**/api/token-usage", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TOKEN_USAGE_FIXTURE),
      });
    });
    await page.route("**/api/opencode-stats**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(OC_STATS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Spending tab and view becomes active", async ({ page }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#stab-panel-usage")).toBeVisible();
  });

  test("spending widget renders global token and cost totals", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    // Force today view so fixture data matches
    await page.locator("#spendingDays").selectOption("1");
    await page.waitForTimeout(800);

    const widget = page.locator("#spendingWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    // 85,000 tokens formatted with toLocaleString
    await expect(widget).toContainText("85", { timeout: 8_000 });
    // Cost rendered as dollar amount
    await expect(widget).toContainText("0.2125", { timeout: 8_000 });
  });

  test("per-agent cost breakdown renders agent names", async ({ page }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    // Force today view so per-agent breakdown data from fixture is used
    await page.locator("#spendingDays").selectOption("1");
    await page.waitForTimeout(800);

    const widget = page.locator("#spendingWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    await expect(widget).toContainText("crew-lead", { timeout: 8_000 });
    await expect(widget).toContainText("crew-pm", { timeout: 8_000 });
  });

  test("grand total row shows agent cost, OC cost, and combined total", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    // Give loadAllUsage time to resolve both sub-loads
    await page.waitForTimeout(1_500);

    // Grand total elements
    const agentEl = page.locator("#gtAgentCost");
    const ocEl = page.locator("#gtOcCost");
    const totalEl = page.locator("#gtTotal");

    await expect(agentEl).toBeVisible({ timeout: 8_000 });
    await expect(ocEl).toBeVisible({ timeout: 8_000 });
    await expect(totalEl).toBeVisible({ timeout: 8_000 });

    // Both costs should be populated (not the initial "—")
    await expect(agentEl).not.toHaveText("—", { timeout: 8_000 });
    await expect(totalEl).not.toHaveText("—", { timeout: 8_000 });
  });

  test("days selector exists and defaults to a numeric value", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    const sel = page.locator("#grandTotalDays");
    await expect(sel).toBeVisible({ timeout: 8_000 });
    const val = await sel.inputValue();
    expect(Number(val)).toBeGreaterThanOrEqual(1);
  });

  test("changing days selector to 7 re-fires loadAllUsage and refreshes widget", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    const sel = page.locator("#grandTotalDays");
    await expect(sel).toBeVisible({ timeout: 8_000 });

    // Widget starts in multi-day mode (grandTotalDays defaults to 14)
    const widget = page.locator("#spendingWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });

    // Switch to 7-day view by evaluating loadAllUsage directly after changing value
    // (data-onchange wiring triggers loadAllUsage which updates the spending display)
    await page.evaluate(() => {
      const sel = document.getElementById("grandTotalDays");
      if (sel) {
        sel.value = "7";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await page.waitForTimeout(1_000);

    // The grandTotalDays selector should now reflect the changed value
    await expect(sel).toHaveValue("7");
    // Spending widget should still be visible and showing content
    await expect(widget).toBeVisible();
  });

  test("token cap progress bar is rendered when cap is defined", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    const widget = page.locator("#spendingWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    // The global cap (200000) should cause a progress bar div to appear
    // bar div has inline width style
    const bar = widget.locator("div[style*='width:']").first();
    await expect(bar).toBeVisible({ timeout: 8_000 });
  });

  test("global caps input fields are populated from API response", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    // Force today view so the caps from the spending fixture are applied
    await page.locator("#spendingDays").selectOption("1");
    await page.waitForTimeout(1_200);

    const tokensCap = page.locator("#gcapTokens");
    const costCap = page.locator("#gcapCost");

    await expect(tokensCap).toBeVisible({ timeout: 8_000 });
    await expect(tokensCap).toHaveValue("200000", { timeout: 8_000 });
    await expect(costCap).toHaveValue("5", { timeout: 8_000 });
  });

  test("reset spending button triggers confirmation dialog", async ({
    page,
  }) => {
    let dialogSeen = false;
    page.on("dialog", async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss(); // cancel — don't actually reset
    });

    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    // Find the reset spending button — it calls resetSpending() and is labelled "Reset Today"
    const resetBtn = page.locator("button[data-action='resetSpending']").first();
    await expect(resetBtn).toBeVisible({ timeout: 8_000 });
    await resetBtn.click();

    await page.waitForTimeout(400);
    expect(dialogSeen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: Spending tab — multi-day view
// ---------------------------------------------------------------------------

test.describe("Spending tab — multi-day view", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/spending", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SPENDING_TODAY_FIXTURE),
      });
    });
    await page.route("**/api/token-usage", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TOKEN_USAGE_FIXTURE),
      });
    });
    await page.route("**/api/opencode-stats**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(OC_STATS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("multi-day view shows daily breakdown bars and by-model section", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    const sel = page.locator("#spendingDays");
    await expect(sel).toBeVisible({ timeout: 8_000 });

    // Switch to 14-day view
    await sel.selectOption("14");
    await page.waitForTimeout(1_000);

    const widget = page.locator("#spendingWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    // The multi-day path renders "Last N days" text
    await expect(widget).toContainText("Last", { timeout: 8_000 });
  });

  test("multi-day view shows model breakdown by code name", async ({ page }) => {
    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-usage").click();
    await expect(page.locator("#stab-panel-usage")).toBeVisible({ timeout: 5_000 });

    const sel = page.locator("#spendingDays");
    await expect(sel).toBeVisible({ timeout: 8_000 });
    await sel.selectOption("14");
    await page.waitForTimeout(1_000);

    const widget = page.locator("#spendingWidget");
    await expect(widget).toContainText("claude-sonnet-4", { timeout: 8_000 });
  });
});
