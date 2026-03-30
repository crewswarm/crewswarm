import { test, expect } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4319";

// ---------------------------------------------------------------------------
// Helpers (same pattern as dashboard-tabs.spec.js)
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
// Suite: PM Loop tab (inside Build view)
// ---------------------------------------------------------------------------

test.describe("PM Loop tab", () => {
  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    // Mock the project picker endpoint
    await page.route("**/api/projects", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [
            {
              id: "proj-1",
              name: "Test Project",
              roadmapFile: "/tmp/roadmap.md",
              dir: "/tmp/proj",
            },
          ],
        }),
      });
    });

    // Mock PM loop status
    await page.route("**/api/pm-loop/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ running: false }),
      });
    });

    // Mock roadmap endpoint
    await page.route("**/api/pm-loop/roadmap", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          content:
            "# Roadmap\n- [ ] Build auth system\n- [ ] Add REST endpoints\n- [x] Setup CI",
        }),
      });
    });

    await openDashboard(page);
  });

  test("navigates to Build tab and PM Loop section is visible", async ({
    page,
  }) => {
    await openTab(page, "navBuild", "buildView");
    await expect(page.locator("#buildView")).toBeVisible();
    // PM Loop heading is inside buildView
    await expect(page.locator("#pmLoopBadge")).toBeVisible({ timeout: 8_000 });
  });

  test("PM Loop start and stop buttons exist", async ({ page }) => {
    await openTab(page, "navBuild", "buildView");

    const startBtn = page.locator("#pmStartBtn");
    const stopBtn = page.locator("#pmStopBtn");
    const dryRunBtn = page.locator("#pmDryRunBtn");

    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await expect(stopBtn).toBeVisible({ timeout: 8_000 });
    await expect(dryRunBtn).toBeVisible({ timeout: 8_000 });

    await expect(startBtn).toContainText("Start");
    await expect(stopBtn).toContainText("Stop");
    await expect(dryRunBtn).toContainText("Dry run");
  });

  test("roadmap button toggles roadmap panel display", async ({ page }) => {
    await openTab(page, "navBuild", "buildView");

    const roadmapBtn = page.locator("#pmRoadmapBtn");
    await expect(roadmapBtn).toBeVisible({ timeout: 8_000 });
    await expect(roadmapBtn).toContainText("Roadmap");

    // Panel should be hidden initially
    const panel = page.locator("#pmRoadmapPanel");
    // Click to show roadmap
    await roadmapBtn.click();
    await page.waitForTimeout(1_000);
    await expect(panel).toBeVisible({ timeout: 8_000 });
    await expect(panel).toContainText("Roadmap");
  });
});

// ---------------------------------------------------------------------------
// Suite: Memory tab
// ---------------------------------------------------------------------------

test.describe("Memory tab", () => {
  const MEMORY_STATS_FIXTURE = {
    available: true,
    storageDir: "/tmp/.crewswarm/memory",
    agentMemory: {
      totalFacts: 42,
      criticalFacts: 5,
      providers: ["openai", "anthropic"],
      oldestFact: "2025-01-15T00:00:00Z",
      newestFact: "2026-03-28T00:00:00Z",
    },
    agentKeeper: {
      entries: 128,
      bytes: 65536,
      byTier: { hot: 30, warm: 60, cold: 38 },
      byAgent: { "crew-coder": 80, "crew-pm": 48 },
    },
  };

  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/memory/stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MEMORY_STATS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test("navigates to Memory tab and view becomes active", async ({ page }) => {
    await openTab(page, "navMemory", "memoryView");
    await expect(page.locator("#memoryView")).toBeVisible();
  });

  test("memory stats cards render fact and keeper data", async ({ page }) => {
    await openTab(page, "navMemory", "memoryView");

    // Wait for stats to load
    const factStats = page.locator("#memoryFactStats");
    await expect(factStats).toBeVisible({ timeout: 8_000 });
    await expect(factStats).toContainText("42", { timeout: 8_000 });
    await expect(factStats).toContainText("5", { timeout: 8_000 });

    const keeperStats = page.locator("#memoryKeeperStats");
    await expect(keeperStats).toBeVisible({ timeout: 8_000 });
    await expect(keeperStats).toContainText("128", { timeout: 8_000 });

    // Storage info
    const storageInfo = page.locator("#memoryStorageInfo");
    await expect(storageInfo).toBeVisible({ timeout: 8_000 });
    await expect(storageInfo).toContainText("Active", { timeout: 8_000 });
  });

  test("search input exists and search button is present", async ({
    page,
  }) => {
    await openTab(page, "navMemory", "memoryView");

    const searchInput = page.locator("#memorySearchQuery");
    await expect(searchInput).toBeVisible({ timeout: 8_000 });
    await expect(searchInput).toHaveAttribute("type", "text");
    await expect(searchInput).toHaveAttribute(
      "placeholder",
      /Search query/,
    );

    // Search button with data-action
    const searchBtn = page.locator('[data-action="searchMemory"]');
    await expect(searchBtn).toBeVisible({ timeout: 8_000 });
    await expect(searchBtn).toContainText("Search");
  });
});

// ---------------------------------------------------------------------------
// Suite: Engines tab
// ---------------------------------------------------------------------------

test.describe("Engines tab (additional)", () => {
  const ENGINES_FIXTURE = {
    engines: [
      {
        id: "claude",
        label: "Claude",
        description: "Anthropic Claude engine",
        ready: true,
        installed: true,
        requiresAuth: false,
        enabled: true,
        envToggle: "USE_CLAUDE",
        traits: ["streaming", "tool-use"],
        docsUrl: "https://docs.anthropic.com",
        source: "builtin",
      },
      {
        id: "codex",
        label: "Codex",
        description: "OpenAI Codex engine",
        ready: true,
        installed: true,
        requiresAuth: false,
        enabled: false,
        envToggle: "USE_CODEX",
        traits: ["batch-mode"],
        source: "builtin",
      },
      {
        id: "docker-sandbox",
        label: "Docker Sandbox",
        description: "Sandboxed execution engine",
        ready: false,
        installed: false,
        requiresAuth: false,
        installCmd: "docker pull crewswarm/sandbox",
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

  test("navigates to Engines tab and engine cards render", async ({
    page,
  }) => {
    await openTab(page, "navEngines", "enginesView");

    const grid = page.locator("#enginesGrid");
    await expect(grid).toBeVisible({ timeout: 8_000 });
    await expect(grid.locator(".card")).toHaveCount(3, { timeout: 8_000 });
  });

  test("engine cards show labels and status for all engines", async ({
    page,
  }) => {
    await openTab(page, "navEngines", "enginesView");

    const grid = page.locator("#enginesGrid");
    await expect(grid).toContainText("Claude", { timeout: 8_000 });
    await expect(grid).toContainText("Codex", { timeout: 8_000 });
    await expect(grid).toContainText("Docker Sandbox", { timeout: 8_000 });
    await expect(grid).toContainText("Ready", { timeout: 8_000 });
    await expect(grid).toContainText("Not installed", { timeout: 8_000 });
  });

  test("toggle checkboxes exist for ready engines with envToggle", async ({
    page,
  }) => {
    await openTab(page, "navEngines", "enginesView");

    // Claude is ready + has envToggle => toggle visible and checked
    const claudeToggle = page.locator("#toggle-claude");
    await expect(claudeToggle).toBeVisible({ timeout: 8_000 });
    await expect(claudeToggle).toBeChecked();

    // Codex is ready + has envToggle => toggle visible and unchecked
    const codexToggle = page.locator("#toggle-codex");
    await expect(codexToggle).toBeVisible({ timeout: 8_000 });
    await expect(codexToggle).not.toBeChecked();

    // Docker-sandbox is not ready => no toggle
    const dockerToggle = page.locator("#toggle-docker-sandbox");
    await expect(dockerToggle).not.toBeVisible({ timeout: 4_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Spending tab (inside Settings > Usage sub-tab)
// ---------------------------------------------------------------------------

test.describe("Spending tab", () => {
  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    // Mock the spending endpoint (today's data)
    await page.route("**/api/spending", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          spending: {
            date: "2026-03-28",
            global: { tokens: 150000, costUSD: 2.3456 },
            agents: {
              "crew-coder": { tokens: 80000, costUSD: 1.2 },
              "crew-pm": { tokens: 70000, costUSD: 1.1456 },
            },
          },
          caps: {
            global: { dailyTokenLimit: 500000, dailyCostLimitUSD: 10 },
            agents: {},
          },
        }),
      });
    });

    // Mock token-usage endpoint for multi-day view
    await page.route("**/api/token-usage", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ byDay: {} }),
      });
    });

    // Mock OC stats endpoint
    await page.route("**/api/oc-stats**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [], totalCost: 0 }),
      });
    });

    await openDashboard(page);
  });

  test("navigates to Settings tab and usage panel is visible", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");
    await expect(page.locator("#settingsView")).toBeVisible();

    // Usage sub-tab panel should be visible by default
    const usagePanel = page.locator("#stab-panel-usage");
    await expect(usagePanel).toBeVisible({ timeout: 8_000 });
  });

  test("spending widget renders cost breakdown with agent data", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    // Set spendingDays to 1 and dispatch change to trigger loadSpending
    // which reads days=1 and fetches /api/spending (today mode).
    await page.evaluate(() => {
      const sel = document.getElementById("spendingDays");
      if (sel) {
        sel.value = "1";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await page.waitForTimeout(2_000);

    const spendingWidget = page.locator("#spendingWidget");
    await expect(spendingWidget).toBeVisible({ timeout: 8_000 });

    // Verify the spending data rendered from our mock
    await expect(spendingWidget).toContainText("Global", { timeout: 8_000 });
    await expect(spendingWidget).toContainText("$2.3456", { timeout: 8_000 });
    await expect(spendingWidget).toContainText("crew-coder", {
      timeout: 8_000,
    });
    await expect(spendingWidget).toContainText("crew-pm", { timeout: 8_000 });
  });

  test("grand total elements and spending days selector exist", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    // Grand total elements should exist in the usage panel
    const gtAgentCost = page.locator("#gtAgentCost");
    await expect(gtAgentCost).toBeVisible({ timeout: 8_000 });

    const gtOcCost = page.locator("#gtOcCost");
    await expect(gtOcCost).toBeVisible({ timeout: 8_000 });

    const gtTotal = page.locator("#gtTotal");
    await expect(gtTotal).toBeVisible({ timeout: 8_000 });

    // Spending days selector should be present
    const spendingDays = page.locator("#spendingDays");
    await expect(spendingDays).toBeVisible({ timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Prompts tab
// ---------------------------------------------------------------------------

test.describe("Prompts tab", () => {
  const PROMPTS_FIXTURE = {
    prompts: {
      "crew-coder":
        "You are crew-coder, a full-stack coding specialist for CrewSwarm. You write clean, tested code.",
      "crew-pm":
        "You are crew-pm, the project manager agent. You plan work and track progress.",
      "crew-qa":
        "You are crew-qa, a quality assurance agent. You review code for correctness and security.",
    },
  };

  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/prompts", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROMPTS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test("navigates to Prompts tab and view becomes active", async ({
    page,
  }) => {
    await openTab(page, "navPrompts", "promptsView");
    await expect(page.locator("#promptsView")).toBeVisible();
  });

  test("prompt list renders all agent prompt cards", async ({ page }) => {
    await openTab(page, "navPrompts", "promptsView");

    const list = page.locator("#promptsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // All three agents should appear
    await expect(list).toContainText("crew-coder", { timeout: 8_000 });
    await expect(list).toContainText("crew-pm", { timeout: 8_000 });
    await expect(list).toContainText("crew-qa", { timeout: 8_000 });

    // Prompt cards should render
    const cards = list.locator(".prompt-card");
    await expect(cards).toHaveCount(3, { timeout: 8_000 });
  });

  test("prompt cards show preview text and edit buttons", async ({ page }) => {
    await openTab(page, "navPrompts", "promptsView");

    const list = page.locator("#promptsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // Preview text from the prompt should appear
    await expect(list).toContainText("full-stack coding specialist", {
      timeout: 8_000,
    });

    // Edit buttons should exist for each card
    const editBtns = list.locator(".prompt-edit-btn");
    await expect(editBtns).toHaveCount(3, { timeout: 8_000 });

    // Prompts count badge
    const count = page.locator("#promptsCount");
    await expect(count).toContainText("3", { timeout: 8_000 });
  });
});
