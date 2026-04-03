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

const SESSIONS_FIXTURE = [
  {
    id: "session-abc-123",
    title: "crew-coder: Add dashboard tests",
    slug: "fleet-wolf",
    directory: "/Users/dev/project",
  },
  {
    id: "session-xyz-456",
    title: "crew-pm: Roadmap planning Q2",
    slug: "quiet-lake",
    directory: "/Users/dev/project",
  },
  {
    id: "session-def-789",
    title: "Research task: competitor analysis",
    slug: "bold-river",
    directory: "/Users/dev/other",
  },
];

const MESSAGES_FIXTURE = [
  {
    info: { role: "user", createdAt: "2026-04-01T10:00:00Z" },
    parts: [{ type: "text", text: "Please fix the login bug." }],
  },
  {
    info: { role: "assistant", createdAt: "2026-04-01T10:00:05Z" },
    parts: [{ type: "text", text: "I found the issue in auth.js line 42." }],
  },
];

const RT_MESSAGES_FIXTURE = [
  {
    type: "task.dispatched",
    from: "crew-lead",
    to: "crew-coder",
    ts: Date.now() - 60_000,
    payload: { prompt: "Fix the login bug in auth.js" },
  },
  {
    type: "task.done",
    from: "crew-coder",
    to: "crew-lead",
    ts: Date.now() - 30_000,
    payload: { reply: "Done. Fixed auth.js line 42.", engineUsed: "opencode" },
  },
  {
    type: "task.reply",
    from: "crew-qa",
    to: "crew-lead",
    ts: Date.now() - 10_000,
    payload: { reply: "QA passed. No regressions found." },
  },
];

const DLQ_FIXTURE = [
  {
    key: "dlq-entry-001",
    filename: "dlq-entry-001.json",
    agent: "crew-coder",
    failedAt: "2026-04-01T09:00:00Z",
    error: "Task timed out after 120s",
  },
];

// ---------------------------------------------------------------------------
// Suite: Swarm (Sessions) tab
// ---------------------------------------------------------------------------

test.describe("Swarm (Sessions) tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    // Stub engine-sessions endpoint (default engine: opencode)
    await page.route("**/api/engine-sessions**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: SESSIONS_FIXTURE }),
      });
    });

    // Stub messages endpoint
    await page.route("**/api/messages**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MESSAGES_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Swarm tab and sessionsView becomes active", async ({
    page,
  }) => {
    await openTab(page, "navSwarm", "sessionsView");
    await expect(page.locator("#sessionsView")).toBeVisible();
  });

  test("session list renders sessions from API", async ({ page }) => {
    await openTab(page, "navSwarm", "sessionsView");

    const sessions = page.locator("#sessions");
    await expect(sessions).toBeVisible({ timeout: 8_000 });
    await expect(sessions).toContainText(
      "crew-coder: Add dashboard tests",
      { timeout: 8_000 }
    );
    await expect(sessions).toContainText(
      "crew-pm: Roadmap planning Q2",
      { timeout: 8_000 }
    );
  });

  test("session count badge shows correct count", async ({ page }) => {
    await openTab(page, "navSwarm", "sessionsView");

    const countEl = page.locator("#session-count");
    await expect(countEl).toBeVisible({ timeout: 8_000 });
    await expect(countEl).toContainText("3 sessions", { timeout: 8_000 });
  });

  test("engine selector dropdown renders all engine options", async ({
    page,
  }) => {
    await openTab(page, "navSwarm", "sessionsView");

    const select = page.locator("#engine-select");
    await expect(select).toBeVisible({ timeout: 8_000 });
    await expect(select.locator("option[value='opencode']")).toHaveCount(1);
    await expect(select.locator("option[value='claude']")).toHaveCount(1);
    await expect(select.locator("option[value='codex']")).toHaveCount(1);
    await expect(select.locator("option[value='gemini']")).toHaveCount(1);
    await expect(select.locator("option[value='crew-cli']")).toHaveCount(1);
  });

  test("switching engine calls engine-sessions with correct engine param", async ({
    page,
  }) => {
    const capturedUrls = [];
    await page.route("**/api/engine-sessions**", async (route) => {
      capturedUrls.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await openTab(page, "navSwarm", "sessionsView");

    const select = page.locator("#engine-select");
    await expect(select).toBeVisible({ timeout: 8_000 });
    await select.selectOption("claude");
    await page.waitForTimeout(500);

    // At least one request should include engine=claude
    const claudeRequest = capturedUrls.find((url) =>
      url.includes("engine=claude")
    );
    expect(claudeRequest).toBeDefined();
  });

  test("empty state message shows engine name when no sessions exist", async ({
    page,
  }) => {
    await page.route("**/api/engine-sessions**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await openTab(page, "navSwarm", "sessionsView");

    const sessions = page.locator("#sessions");
    await expect(sessions).toBeVisible({ timeout: 8_000 });
    await expect(sessions).toContainText("No OpenCode sessions", {
      timeout: 8_000,
    });
  });

  test("clicking a session row loads its messages", async ({ page }) => {
    await openTab(page, "navSwarm", "sessionsView");

    // Wait for session rows to appear (they are plain divs with class 'row')
    const sessionRows = page.locator("#sessions .row");
    await expect(sessionRows).toHaveCount(3, { timeout: 8_000 });

    // Click the first session
    await sessionRows.first().click();
    await page.waitForTimeout(600);

    // Messages box should be populated
    const messages = page.locator("#messages");
    await expect(messages).toBeVisible({ timeout: 8_000 });
    // Should contain message text (not the "no session selected" fallback)
    await expect(messages).not.toContainText("No session selected.", {
      timeout: 4_000,
    });
  });

  test("session rows show agent badge for crew-assigned sessions", async ({
    page,
  }) => {
    await openTab(page, "navSwarm", "sessionsView");

    const sessions = page.locator("#sessions");
    await expect(sessions).toBeVisible({ timeout: 8_000 });
    // crew-coder title should surface an agent badge
    await expect(sessions).toContainText("Assigned to:", { timeout: 8_000 });
  });

  test("messages pane shows role and text from API response", async ({
    page,
  }) => {
    await openTab(page, "navSwarm", "sessionsView");

    const sessionRows = page.locator("#sessions .row");
    await expect(sessionRows.first()).toBeVisible({ timeout: 8_000 });
    await sessionRows.first().click();
    await page.waitForTimeout(600);

    const messages = page.locator("#messages");
    await expect(messages).toContainText("Please fix the login bug.", {
      timeout: 8_000,
    });
    await expect(messages).toContainText("I found the issue in auth.js", {
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Suite: RT Messages tab
// ---------------------------------------------------------------------------

test.describe("RT Messages tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/rt-messages", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(RT_MESSAGES_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to RT Messages tab and rtView becomes active", async ({
    page,
  }) => {
    await openTab(page, "navRT", "rtView");
    await expect(page.locator("#rtView")).toBeVisible();
  });

  test("RT messages render with agent and phase information", async ({
    page,
  }) => {
    await openTab(page, "navRT", "rtView");

    const box = page.locator("#rtMessages");
    await expect(box).toBeVisible({ timeout: 8_000 });
    // Agents should appear (strip 'crew-' prefix in rendering)
    await expect(box).toContainText("lead", { timeout: 8_000 });
    await expect(box).toContainText("dispatched", { timeout: 8_000 });
  });

  test("RT messages show phase badges for task types", async ({ page }) => {
    await openTab(page, "navRT", "rtView");

    const box = page.locator("#rtMessages");
    await expect(box).toContainText("done", { timeout: 8_000 });
    await expect(box).toContainText("reply", { timeout: 8_000 });
  });

  test("Pause button toggles pause state", async ({ page }) => {
    await openTab(page, "navRT", "rtView");

    const pauseBtn = page.locator("#rtPauseBtn");
    await expect(pauseBtn).toBeVisible({ timeout: 8_000 });
    await expect(pauseBtn).toContainText("Pause");

    await pauseBtn.click();
    await expect(pauseBtn).toContainText("Resume", { timeout: 4_000 });
  });

  test("filter chip switches to all-messages mode", async ({ page }) => {
    await openTab(page, "navRT", "rtView");

    // Default filter is 'tasks'. Click the 'all' chip.
    const allChip = page.locator(".rt-filter-chip[data-filter='all']");
    await expect(allChip).toBeVisible({ timeout: 8_000 });
    await allChip.click();
    await page.waitForTimeout(400);

    // Chip should now be visually active
    await expect(allChip).toHaveClass(/active/, { timeout: 4_000 });
  });

  test("search box filters messages by text", async ({ page }) => {
    await openTab(page, "navRT", "rtView");

    const search = page.locator("#rtSearch");
    await expect(search).toBeVisible({ timeout: 8_000 });
    await search.fill("nonexistent-query-xyz");
    await page.waitForTimeout(600);

    const box = page.locator("#rtMessages");
    // No matching messages — empty state
    await expect(box).toContainText(
      "No events match the current filter.",
      { timeout: 8_000 }
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: DLQ tab
// ---------------------------------------------------------------------------

test.describe("DLQ tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/dlq", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(DLQ_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to DLQ tab and dlqView becomes active", async ({ page }) => {
    await openTab(page, "navDLQ", "dlqView");
    await expect(page.locator("#dlqView")).toBeVisible();
  });

  test("DLQ badge shows count when there are failed items", async ({
    page,
  }) => {
    await openTab(page, "navDLQ", "dlqView");

    const badge = page.locator("#dlqBadge");
    await expect(badge).not.toHaveClass(/hidden/, { timeout: 8_000 });
    await expect(badge).toContainText("1", { timeout: 8_000 });
  });

  test("DLQ items render with agent and error information", async ({
    page,
  }) => {
    await openTab(page, "navDLQ", "dlqView");

    const dlqBox = page.locator("#dlqMessages");
    await expect(dlqBox).toBeVisible({ timeout: 8_000 });
    await expect(dlqBox).toContainText("crew-coder", { timeout: 8_000 });
    await expect(dlqBox).toContainText("Task timed out after 120s", {
      timeout: 8_000,
    });
  });

  test("DLQ items render Replay and Delete buttons", async ({ page }) => {
    await openTab(page, "navDLQ", "dlqView");

    const dlqBox = page.locator("#dlqMessages");
    await expect(dlqBox).toBeVisible({ timeout: 8_000 });
    await expect(dlqBox.locator(".replay-btn")).toBeVisible({ timeout: 8_000 });
    await expect(
      dlqBox.locator("button", { hasText: "Delete" })
    ).toBeVisible({ timeout: 8_000 });
  });

  test("empty DLQ shows confirmation message", async ({ page }) => {
    await page.route("**/api/dlq", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await openTab(page, "navDLQ", "dlqView");

    const dlqBox = page.locator("#dlqMessages");
    await expect(dlqBox).toContainText("✓ DLQ empty", { timeout: 8_000 });
  });

  test("Replay button calls POST /api/dlq/replay with correct key", async ({
    page,
  }) => {
    const replayRequests = [];
    await page.route("**/api/dlq/replay", async (route) => {
      const body = route.request().postDataJSON();
      replayRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    // Suppress the confirm dialog
    page.on("dialog", (dialog) => dialog.accept());
    // Re-load DLQ after replay
    await page.route("**/api/dlq", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(DLQ_FIXTURE),
      });
    });

    await openTab(page, "navDLQ", "dlqView");

    const replayBtn = page.locator(".replay-btn").first();
    await expect(replayBtn).toBeVisible({ timeout: 8_000 });
    await replayBtn.click();
    await page.waitForTimeout(800);

    expect(replayRequests.length).toBe(1);
    expect(replayRequests[0]).toHaveProperty("key", "dlq-entry-001");
  });
});
