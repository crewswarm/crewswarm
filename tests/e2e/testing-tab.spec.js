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

  // ---------------------------------------------------------------------------
  // New feature tests
  // ---------------------------------------------------------------------------

  test("suite cards render with correct suite names", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 200, failed: 0, skipped: 0, total: 200, duration_ms: 8000 },
          groups: [
            { category: "unit", group: "agents", files: 10, tests: 80, pass: 80, fail: 0, skip: 0, duration_ms: 2000 },
            { category: "integration", group: "dashboard", files: 3, tests: 50, pass: 50, fail: 0, skip: 0, duration_ms: 3000 },
            { category: "e2e", group: "playwright", files: 5, tests: 40, pass: 40, fail: 0, skip: 0, duration_ms: 2500 },
            { category: "e2e", group: "playwright", files: 2, tests: 20, pass: 20, fail: 0, skip: 0, duration_ms: 1000 },
            { category: "unit", group: "crew-cli", files: 4, tests: 10, pass: 10, fail: 0, skip: 0, duration_ms: 500 },
          ],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    // Suite cards or group table should include the expected category/group names
    const content = page.locator("#testingView");
    await expect(content).toBeVisible({ timeout: 10_000 });
    await expect(content).toContainText("unit", { timeout: 10_000 });
    await expect(content).toContainText("integration");
    await expect(content).toContainText("e2e");
  });

  test("per-file run button exists in suite breakdown", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 10, failed: 0, skipped: 0, total: 10, duration_ms: 500 },
          groups: [
            { category: "unit", group: "agents", files: 3, tests: 10, pass: 10, fail: 0, skip: 0, duration_ms: 500 },
          ],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    // At least one run button should be present in the testing view
    await expect(page.locator("#testingView")).toBeVisible({ timeout: 10_000 });
    const runBtns = page.locator('#testingView button[data-arg], #testingView .test-run-btn, #testingView button[data-action="runTests"]');
    await expect(runBtns.first()).toBeVisible({ timeout: 10_000 });
  });

  test("clicking run button calls POST /api/tests/run", async ({ page }) => {
    let runCalled = false;
    let runBody = null;

    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 10, failed: 0, skipped: 0, total: 10, duration_ms: 500 },
          groups: [{ category: "unit", group: "agents", files: 3, tests: 10, pass: 10, fail: 0, skip: 0, duration_ms: 500 }],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });
    await page.route("**/api/tests/run", async (route) => {
      runCalled = true;
      const reqBody = route.request().postDataJSON().catch(() => null);
      runBody = await reqBody;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, runId: "new-run-1" }),
      });
    });
    // Mock SSE stream endpoint so live output panel can open
    await page.route("**/api/tests/stream**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "data: {\"type\":\"done\"}\n\n",
      });
    });

    await openTab(page, "navTesting", "testingView");
    await expect(page.locator("#testingView")).toBeVisible({ timeout: 10_000 });

    // Click the first available run button
    const runBtn = page.locator('.test-actions [data-arg="test:unit"], .test-actions [data-arg="test:all"], #testingView button[data-action="runTests"]').first();
    await expect(runBtn).toBeVisible({ timeout: 10_000 });
    await runBtn.click();
    await page.waitForTimeout(600);

    expect(runCalled).toBe(true);
  });

  test("stale badge renders for stale files from /api/tests/stale", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 40, failed: 0, skipped: 0, total: 40, duration_ms: 2000 },
          groups: [
            { category: "unit", group: "agents", files: 5, tests: 40, pass: 40, fail: 0, skip: 0, duration_ms: 2000 },
          ],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });
    await page.route("**/api/tests/stale", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stale: [
            { file: "test/unit/agents.test.mjs", reason: "source changed", age_ms: 86400000 },
            { file: "test/unit/chat.test.mjs", reason: "source changed", age_ms: 43200000 },
          ],
        }),
      });
    });

    await openTab(page, "navTesting", "testingView");

    // Stale badge or stale indicator should appear somewhere in the testing view
    await expect(page.locator("#testingView")).toBeVisible({ timeout: 10_000 });
    // Look for stale badge element — either a dedicated badge or text containing "stale"
    const staleBadge = page.locator(".test-stale-badge, [data-stale], .stale-badge, #testingView *:has-text('stale')").first();
    await expect(staleBadge).toBeVisible({ timeout: 10_000 });
  });

  test("coverage heatmap section renders with blocks", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 100, failed: 0, skipped: 0, total: 100, duration_ms: 5000 },
          groups: [{ category: "unit", group: "agents", files: 10, tests: 100, pass: 100, fail: 0, skip: 0, duration_ms: 5000 }],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });
    await page.route("**/api/tests/coverage-map", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          covered: [
            "lib/agents/crew-lead.mjs",
            "lib/agents/crew-coder.mjs",
            "lib/chat/router.mjs",
          ],
          uncovered: [
            "lib/agents/crew-scribe.mjs",
            "lib/bridges/telegram.mjs",
          ],
          pct: 60,
        }),
      });
    });

    await openTab(page, "navTesting", "testingView");

    await expect(page.locator("#testingView")).toBeVisible({ timeout: 10_000 });
    // Coverage heatmap section should render
    const heatmap = page.locator(".test-coverage-heatmap, #coverageHeatmap, [data-section='coverage']");
    await expect(heatmap.first()).toBeVisible({ timeout: 10_000 });
    // Green blocks (covered files) should be present
    const coveredBlocks = page.locator(".coverage-block-covered, .coverage-block.covered, [data-covered='true']");
    await expect(coveredBlocks.first()).toBeVisible({ timeout: 10_000 });
  });

  test("run history chart SVG renders with bars", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r3", timestamp: new Date().toISOString(), status: "passed", passed: 50, failed: 0, skipped: 0, total: 50, duration_ms: 2000 },
          groups: [],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          history: [
            { runId: "r3", timestamp: "2026-04-04T03:00:00.000Z", status: "passed", passed: 50, failed: 0, skipped: 0, total: 50, duration_ms: 2000 },
            { runId: "r2", timestamp: "2026-04-04T02:00:00.000Z", status: "failed", passed: 47, failed: 3, skipped: 0, total: 50, duration_ms: 2200 },
            { runId: "r1", timestamp: "2026-04-04T01:00:00.000Z", status: "passed", passed: 50, failed: 0, skipped: 0, total: 50, duration_ms: 1900 },
          ],
        }),
      });
    });

    await openTab(page, "navTesting", "testingView");

    // History chart should render — either .test-history-chart with SVG or an SVG directly
    const chart = page.locator(".test-history-chart, #testRunHistoryChart, svg.test-chart");
    await expect(chart.first()).toBeVisible({ timeout: 10_000 });
    // Bars rendered inside the chart (rect or .test-history-bar)
    const bars = page.locator(".test-history-bar, .test-history-chart rect, svg.test-chart rect");
    const barCount = await bars.count();
    expect(barCount).toBeGreaterThan(0);
  });

  test("live output panel appears when a test run starts", async ({ page }) => {
    let streamRequested = false;

    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "passed", passed: 10, failed: 0, skipped: 0, total: 10, duration_ms: 500 },
          groups: [{ category: "unit", group: "agents", files: 2, tests: 10, pass: 10, fail: 0, skip: 0, duration_ms: 500 }],
          failures: [],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });
    await page.route("**/api/tests/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, runId: "live-run-1" }),
      });
    });
    await page.route("**/api/tests/stream**", async (route) => {
      streamRequested = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'data: {"type":"line","text":"TAP version 13"}\n\n',
          'data: {"type":"line","text":"ok 1 - agents test passes"}\n\n',
          'data: {"type":"done","passed":10,"failed":0}\n\n',
        ].join(""),
      });
    });

    await openTab(page, "navTesting", "testingView");
    await expect(page.locator("#testingView")).toBeVisible({ timeout: 10_000 });

    // Click a run button to trigger live output
    const runBtn = page.locator('.test-actions [data-arg="test:unit"], .test-actions [data-arg="test:all"], #testingView button[data-action="runTests"]').first();
    await expect(runBtn).toBeVisible({ timeout: 10_000 });
    await runBtn.click();
    await page.waitForTimeout(800);

    // Live output panel should become visible after clicking run
    const livePanel = page.locator(".test-live-output, #testLiveOutput, [data-panel='live-output'], .test-output-panel");
    await expect(livePanel.first()).toBeVisible({ timeout: 10_000 });
  });

  test("failure drill-down expands on click showing error details", async ({ page }) => {
    await page.route("**/api/tests/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastRun: { runId: "r1", timestamp: new Date().toISOString(), status: "failed", passed: 97, failed: 3, skipped: 0, total: 100, duration_ms: 5000 },
          groups: [{ category: "unit", group: "agents", files: 5, tests: 100, pass: 97, fail: 3, skip: 0, duration_ms: 5000 }],
          failures: [
            {
              testId: "t1",
              name: "agents validation rejects null input",
              file: "test/unit/agents-validation.test.mjs",
              error: "AssertionError: expected null to be rejected\n    at Object.<anonymous> (test/unit/agents-validation.test.mjs:42:5)",
              classification: "assertion",
              rerun_command: "node --test test/unit/agents-validation.test.mjs",
            },
          ],
        }),
      });
    });
    await page.route("**/api/tests/history", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ history: [] }) });
    });

    await openTab(page, "navTesting", "testingView");

    // Failure card should render
    const card = page.locator(".test-failure-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Click to expand drill-down (may be a toggle, details element, or expand button)
    const expandTrigger = card.locator("summary, .test-failure-expand, button.expand, .test-failure-toggle, .test-failure-name").first();
    await expandTrigger.click();
    await page.waitForTimeout(400);

    // Error details should now be visible (stack trace, rerun command, or error text)
    const errorDetail = card.locator(".test-failure-error, .test-failure-stack, .test-failure-detail, pre, code");
    await expect(errorDetail.first()).toBeVisible({ timeout: 8_000 });
    await expect(errorDetail.first()).toContainText("AssertionError");
  });
});
