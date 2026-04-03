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

const TOKEN_USAGE_FIXTURE = {
  prompt: 240000,
  completion: 80000,
  calls: 720,
  byModel: {
    "claude-sonnet-4": { prompt: 150000, completion: 50000 },
    "gpt-5.2": { prompt: 60000, completion: 20000 },
    "grok-4": { prompt: 30000, completion: 10000 },
  },
  byDay: {
    "2026-04-02": {
      prompt: 80000,
      completion: 25000,
      byModel: {
        "claude-sonnet-4": { prompt: 80000, completion: 25000 },
      },
    },
    "2026-04-01": {
      prompt: 100000,
      completion: 35000,
      byModel: {
        "gpt-5.2": { prompt: 60000, completion: 20000 },
        "grok-4": { prompt: 40000, completion: 15000 },
      },
    },
    "2026-03-31": {
      prompt: 60000,
      completion: 20000,
      byModel: {
        "claude-sonnet-4": { prompt: 60000, completion: 20000 },
      },
    },
  },
};

const OC_STATS_FIXTURE = {
  ok: true,
  byDay: {
    "2026-04-02": {
      cost: 1.25,
      input_tok: 600000,
      output_tok: 120000,
      calls: 64,
      byModel: {
        "gpt-5.2": { cost: 1.25, input_tok: 600000, output_tok: 120000, calls: 64 },
      },
    },
    "2026-04-01": {
      cost: 0.80,
      input_tok: 400000,
      output_tok: 80000,
      calls: 40,
      byModel: {
        "gpt-5.2": { cost: 0.80, input_tok: 400000, output_tok: 80000, calls: 40 },
      },
    },
  },
};

const HEALTH_FIXTURE = {
  ok: true,
  agents: [
    {
      id: "crew-main",
      name: "Crew Main",
      emoji: "🤖",
      tools: ["read_file", "write_file", "run_cmd", "dispatch"],
    },
    {
      id: "crew-pm",
      name: "Crew PM",
      emoji: "📋",
      tools: ["read_file", "dispatch", "skill"],
    },
  ],
  telemetry: [
    {
      occurredAt: "2026-04-02T10:15:30",
      data: { phase: "completed", agentId: "crew-main", taskId: "task-abc123" },
    },
    {
      occurredAt: "2026-04-02T09:55:12",
      data: { phase: "failed", agentId: "crew-pm", taskId: "task-def456" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Suite: Usage tab
// ---------------------------------------------------------------------------

test.describe("Usage tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

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
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HEALTH_FIXTURE),
      });
    });
    await page.route("**/api/crew-lead/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ online: true }),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Usage tab and view becomes active", async ({ page }) => {
    await openTab(page, "navUsage", "usageView");
    await expect(page.locator("#usageView")).toBeVisible();
  });

  test("token usage widget renders LLM call count and total tokens", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const widget = page.locator("#tokenUsageWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    // 720 calls
    await expect(widget).toContainText("720", { timeout: 8_000 });
    // 320k total tokens (240000+80000)/1000 = 320.0k
    await expect(widget).toContainText("320.0k", { timeout: 8_000 });
  });

  test("token usage widget renders estimated cost", async ({ page }) => {
    await openTab(page, "navUsage", "usageView");

    const widget = page.locator("#tokenUsageWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    // Cost is shown as "$X.XXXX"
    await expect(widget).toContainText("$", { timeout: 8_000 });
    await expect(widget).toContainText("est. cost", { timeout: 8_000 });
  });

  test("token usage widget renders by-model breakdown", async ({ page }) => {
    await openTab(page, "navUsage", "usageView");

    const widget = page.locator("#tokenUsageWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });

    // All three models from fixture should appear
    await expect(widget).toContainText("claude-sonnet-4", { timeout: 8_000 });
    await expect(widget).toContainText("gpt-5.2", { timeout: 8_000 });
    await expect(widget).toContainText("grok-4", { timeout: 8_000 });
  });

  test("token usage widget shows daily history section", async ({ page }) => {
    await openTab(page, "navUsage", "usageView");

    const widget = page.locator("#tokenUsageWidget");
    await expect(widget).toBeVisible({ timeout: 8_000 });
    await expect(widget).toContainText("Daily cost", { timeout: 8_000 });
  });

  test("opencode stats widget renders total cost and call count", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const ocWidget = page.locator("#ocStatsWidget");
    await expect(ocWidget).toBeVisible({ timeout: 8_000 });
    // Total cost across days: 1.25 + 0.80 = 2.05
    await expect(ocWidget).toContainText("$2.0500", { timeout: 8_000 });
    // Total calls: 64 + 40 = 104
    await expect(ocWidget).toContainText("104", { timeout: 8_000 });
  });

  test("opencode stats days selector exists and accepts numeric option", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const sel = page.locator("#ocStatsDays");
    await expect(sel).toBeVisible({ timeout: 8_000 });
    const val = await sel.inputValue();
    expect(Number(val)).toBeGreaterThanOrEqual(1);
  });

  test("crew-lead status badge reflects online state", async ({ page }) => {
    await openTab(page, "navUsage", "usageView");

    const badge = page.locator("#crewLeadBadge");
    await expect(badge).toBeVisible({ timeout: 8_000 });
    await expect(badge).toContainText("online", { timeout: 8_000 });
  });

  test("tool matrix table renders agents from health endpoint", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const matrix = page.locator("#toolMatrixContainer");
    await expect(matrix).toBeVisible({ timeout: 8_000 });
    await expect(matrix).toContainText("crew-main", { timeout: 8_000 });
    await expect(matrix).toContainText("crew-pm", { timeout: 8_000 });
  });

  test("tool matrix shows checkmarks for tools each agent has", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const matrix = page.locator("#toolMatrixContainer");
    await expect(matrix).toBeVisible({ timeout: 8_000 });
    // Green checkmarks (✓) should be present
    await expect(matrix).toContainText("✓", { timeout: 8_000 });
  });

  test("tool matrix Restart button exists for each agent row", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const matrix = page.locator("#toolMatrixContainer");
    await expect(matrix).toBeVisible({ timeout: 8_000 });
    const restartBtns = matrix.locator(
      'button[data-action="restartAgentFromUI"]'
    );
    await expect(restartBtns).toHaveCount(3, { timeout: 8_000 }); // crew-lead + 2 agents
  });

  test("Restart agent button calls POST /api/agents/:id/restart", async ({
    page,
  }) => {
    const restartRequests = [];
    await page.route("**/api/agents/*/restart", async (route) => {
      restartRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navUsage", "usageView");

    const matrix = page.locator("#toolMatrixContainer");
    await expect(matrix).toBeVisible({ timeout: 8_000 });

    const restartBtn = matrix
      .locator('button[data-action="restartAgentFromUI"][data-arg="crew-main"]')
      .first();
    await expect(restartBtn).toBeVisible({ timeout: 8_000 });
    await restartBtn.click();

    await page.waitForTimeout(600);

    expect(restartRequests.length).toBe(1);
    expect(restartRequests[0]).toContain("crew-main");
  });

  test("task lifecycle table renders completed and failed events", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const lifecycle = page.locator("#taskLifecycleContainer");
    await expect(lifecycle).toBeVisible({ timeout: 8_000 });
    await expect(lifecycle).toContainText("completed", { timeout: 8_000 });
    await expect(lifecycle).toContainText("failed", { timeout: 8_000 });
    await expect(lifecycle).toContainText("crew-main", { timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Usage tab — offline crew-lead
// ---------------------------------------------------------------------------

test.describe("Usage tab — offline crew-lead", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

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
        body: JSON.stringify({ ok: false, error: "No data" }),
      });
    });
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Unauthorized" }),
      });
    });
    await page.route("**/api/crew-lead/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ online: false }),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("crew-lead badge shows offline when status reports offline", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const badge = page.locator("#crewLeadBadge");
    await expect(badge).toBeVisible({ timeout: 8_000 });
    await expect(badge).toContainText("offline", { timeout: 8_000 });
  });

  test("tool matrix shows health check failed message when health returns error", async ({
    page,
  }) => {
    await openTab(page, "navUsage", "usageView");

    const matrix = page.locator("#toolMatrixContainer");
    await expect(matrix).toBeVisible({ timeout: 8_000 });
    await expect(matrix).toContainText("Health check failed", { timeout: 8_000 });
  });
});
