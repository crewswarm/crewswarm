import { test, expect } from "@playwright/test";
import { setupConsoleErrorCapture, expectNoConsoleErrors } from "./helpers.mjs";

const BASE_URL = "http://127.0.0.1:4319";

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
      (el) => el.classList.contains("active") || el.style.display !== "none",
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
// Suite: Testing tab
// ---------------------------------------------------------------------------

test.describe("Testing tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Testing tab and view becomes active", async ({ page }) => {
    await openTab(page, "navTesting", "testingView");
    await expect(page.locator("#testingView")).toBeVisible();
  });

  test("testing tab shows summary card after API response", async ({
    page,
  }) => {
    // Mock the summary endpoint
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: {
            runId: "2026-04-03T02-00-00-000Z",
            timestamp: "2026-04-03T02:00:00.000Z",
            status: "passed",
            passed: 980,
            failed: 8,
            skipped: 2,
            total: 990,
            duration_ms: 12345,
          },
          groups: [
            { category: "unit", group: "agents", files: 8, tests: 350, pass: 348, fail: 2, skip: 0, duration_ms: 3200 },
            { category: "unit", group: "chat", files: 6, tests: 190, pass: 190, fail: 0, skip: 0, duration_ms: 1800 },
            { category: "integration", group: "dashboard", files: 2, tests: 33, pass: 30, fail: 3, skip: 0, duration_ms: 5000 },
          ],
          failures: [
            { testId: "test-1", name: "agents validation rejects bad input", file: "test/unit/agents-validation.test.mjs", error: "AssertionError: expected true to be false", classification: "assertion", rerun_command: "node --test test/unit/agents-validation.test.mjs" },
          ],
        }),
      });
    });

    // Mock history endpoint
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          history: [
            { runId: "2026-04-03T02-00-00-000Z", timestamp: "2026-04-03T02:00:00.000Z", status: "failed", passed: 980, failed: 8, skipped: 2, total: 990, duration_ms: 12345 },
            { runId: "2026-04-03T01-00-00-000Z", timestamp: "2026-04-03T01:00:00.000Z", status: "passed", passed: 990, failed: 0, skipped: 0, total: 990, duration_ms: 11000 },
          ],
        }),
      });
    });

    await openTab(page, "navTesting", "testingView");

    // Summary card should render
    await expect(page.locator(".test-summary-card")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".test-summary-status")).toContainText("FAILING");

    // Stats should show
    await expect(page.locator(".test-stat-value.test-color-pass")).toContainText("980");
    await expect(page.locator(".test-stat-value.test-color-fail")).toContainText("8");

    // Progress bar should exist
    await expect(page.locator(".test-progress-bar")).toBeVisible();
  });

  test("testing tab renders group breakdown table", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 100, failed: 0, skipped: 0, total: 100, duration_ms: 5000 },
          groups: [
            { category: "unit", group: "agents", files: 5, tests: 60, pass: 60, fail: 0, skip: 0, duration_ms: 2000 },
            { category: "unit", group: "chat", files: 3, tests: 40, pass: 40, fail: 0, skip: 0, duration_ms: 1500 },
          ],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    // Group table should render with rows
    await expect(page.locator(".test-groups-table")).toBeVisible({ timeout: 10_000 });
    const rows = page.locator(".test-groups-table tbody tr");
    await expect(rows).toHaveCount(2);

    // Category badges
    await expect(page.locator(".test-cat-unit").first()).toContainText("unit");
  });

  test("testing tab shows failure cards when tests fail", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "failed", passed: 98, failed: 2, skipped: 0, total: 100, duration_ms: 5000 },
          groups: [{ category: "unit", group: "agents", files: 5, tests: 100, pass: 98, fail: 2, skip: 0, duration_ms: 5000 }],
          failures: [
            { testId: "t1", name: "test alpha fails", file: "test/unit/alpha.test.mjs", error: "Expected 1 to equal 2", classification: "assertion", rerun_command: "node --test test/unit/alpha.test.mjs" },
            { testId: "t2", name: "test beta timeout", file: "test/unit/beta.test.mjs", error: "Timeout 5000ms", classification: "timeout", rerun_command: "" },
          ],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    // Failure cards should render
    const cards = page.locator(".test-failure-card");
    await expect(cards).toHaveCount(2, { timeout: 10_000 });
    await expect(cards.first().locator(".test-failure-name")).toContainText("test alpha fails");
    await expect(cards.first().locator(".test-failure-error")).toContainText("Expected 1 to equal 2");
  });

  test("testing tab renders run history", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 50, failed: 0, skipped: 0, total: 50, duration_ms: 2000 }, groups: [], failures: [] }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          history: [
            { runId: "r3", timestamp: "2026-04-03T03:00:00.000Z", status: "passed", passed: 50, failed: 0, skipped: 0, total: 50, duration_ms: 2000 },
            { runId: "r2", timestamp: "2026-04-03T02:00:00.000Z", status: "failed", passed: 48, failed: 2, skipped: 0, total: 50, duration_ms: 2100 },
            { runId: "r1", timestamp: "2026-04-03T01:00:00.000Z", status: "passed", passed: 50, failed: 0, skipped: 0, total: 50, duration_ms: 1900 },
          ],
        }),
      });
    });

    await openTab(page, "navTesting", "testingView");

    // History chart bars
    await expect(page.locator(".test-history-chart")).toBeVisible({ timeout: 10_000 });
    const bars = page.locator(".test-history-bar");
    await expect(bars).toHaveCount(3);

    // History table rows
    const tableRows = page.locator(".test-history-table tbody tr");
    await expect(tableRows).toHaveCount(3);
  });

  test("run test buttons are present", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 10, failed: 0, skipped: 0, total: 10, duration_ms: 500 }, groups: [], failures: [] }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    // Run buttons should be visible
    await expect(page.locator('.test-actions [data-arg="test:unit"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.test-actions [data-arg="test:integration"]')).toBeVisible();
    await expect(page.locator('.test-actions [data-arg="test:e2e"]')).toBeVisible();
    await expect(page.locator('.test-actions [data-arg="test:all"]')).toBeVisible();
  });

  test("empty state renders when no test results exist", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ lastRun: null, groups: [], failures: [] }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    await expect(page.locator("#testingContent .empty-state")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#testingContent .empty-state")).toContainText("No test results");
  });
});
