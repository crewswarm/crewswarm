import { test, expect } from "@playwright/test";

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
    .evaluate((el) => el.classList.contains("active") || el.style.display !== "none")
    .catch(() => false);
  if (!isActive) {
    const dataView = await page.locator(`#${navId}`).getAttribute("data-view");
    if (dataView) {
      await page.evaluate((v) => {
        window.location.hash = v;
      }, dataView);
    }
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

test.describe("Dashboard core surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await disableDashboardSSE(page);

    await page.route("**/api/projects", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [
            { id: "general", name: "General" },
            { id: "alpha", name: "Alpha Project" },
          ],
        }),
      });
    });

    await page.route("**/api/crew-lead/info", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          name: "crew-lead",
          emoji: "🧠",
        }),
      });
    });

    await page.route("**/api/agents-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          allModels: ["openai/gpt-5.4"],
          modelsByProvider: {},
          agents: [
            { id: "crew-coder", name: "crew-coder", emoji: "🤖", model: "openai/gpt-5.4" },
          ],
        }),
      });
    });

    await waitForDashboardHealth(page);
    await openDashboard(page);
  });

  test("Chat tab loads unified history and send posts to unified endpoint", async ({ page }) => {
    let sentPayload = null;

    await page.route("**/api/crew-lead/project-messages**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          messages: [
            {
              role: "assistant",
              content: "Earlier crew context",
              ts: new Date().toISOString(),
              source: "dashboard",
              metadata: { engine: "crew-lead" },
            },
          ],
        }),
      });
    });

    await page.route("**/api/chat/unified", async (route) => {
      sentPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          reply: "Synthetic assistant reply",
        }),
      });
    });

    await openTab(page, "navChat", "chatView");
    await expect(page.locator("#chatMessages")).toContainText("Earlier crew context");

    await page.fill("#chatInput", "Please summarize this project");
    await page.locator('[data-action="sendChat"]').click();

    await expect.poll(() => sentPayload).not.toBeNull();
    expect(sentPayload?.message || sentPayload?.text || "").toContain("Please summarize this project");
    await expect(page.locator("#chatMessages")).toContainText("Synthetic assistant reply", {
      timeout: 10_000,
    });
  });

  test("Memory tab renders stats and search results", async ({ page }) => {
    await page.route("**/api/memory/stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          storageDir: "/tmp/crewswarm-memory",
          agentMemory: {
            totalFacts: 12,
            criticalFacts: 3,
            providers: ["openai", "anthropic"],
            oldestFact: "2026-03-20T00:00:00.000Z",
            newestFact: "2026-03-29T00:00:00.000Z",
          },
          agentKeeper: {
            entries: 22,
            bytes: 4096,
            byTier: { l1: 5, l2: 10, l3: 7 },
            byAgent: { "crew-coder": 9, "crew-pm": 4 },
          },
        }),
      });
    });

    await page.route("**/api/memory/search", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hits: [
            {
              source: "agent-memory",
              title: "Authentication decision",
              text: "Use JWT auth with admin 2FA for protected routes.",
              score: 0.91,
              metadata: { agent: "crew-pm" },
            },
          ],
        }),
      });
    });

    await openTab(page, "navMemory", "memoryView");
    await expect(page.locator("#memoryFactStats")).toContainText("Total facts: 12");
    await expect(page.locator("#memoryKeeperStats")).toContainText("Total entries: 22");
    await expect(page.locator("#memoryStorageInfo")).toContainText("/tmp/crewswarm-memory");

    await page.fill("#memorySearchQuery", "authentication");
    await page.locator('[data-action="searchMemory"]').click();

    await expect(page.locator("#memorySearchResults")).toContainText("Authentication decision");
    await expect(page.locator("#memorySearchResults")).toContainText("Use JWT auth");
  });

  test("Benchmarks tab loads options and leaderboard rows", async ({ page }) => {
    await page.route("**/api/zeroeval/benchmarks", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { benchmark_id: "swe-bench-verified", name: "SWE-Bench Verified" },
          { benchmark_id: "livecodebench", name: "LiveCodeBench" },
        ]),
      });
    });

    await page.route("**/api/zeroeval/benchmarks/swe-bench-verified", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          benchmark_name: "SWE-Bench Verified",
          benchmark_description: "Real-world software tasks",
          total_models: 2,
          statistics: { average_score: 0.53 },
          entries: [
            {
              rank: 1,
              model_name: "gpt-5.4",
              organization_name: "OpenAI",
              normalized_score: 0.67,
              input_cost_per_million: 1.25,
              output_cost_per_million: 10,
              analysis_method: "measured",
            },
            {
              rank: 2,
              model_name: "claude-sonnet-4-5",
              organization_name: "Anthropic",
              normalized_score: 0.39,
              input_cost_per_million: 3,
              output_cost_per_million: 15,
              analysis_method: "estimated",
            },
          ],
        }),
      });
    });

    await openTab(page, "navBenchmarks", "benchmarksView");
    await expect(page.locator("#benchmarkSelect")).toHaveValue("swe-bench-verified");
    await expect(page.locator("#benchmarkMeta")).toContainText("SWE-Bench Verified");
    await expect(page.locator("#benchmarkTable")).toContainText("gpt-5.4");
    await expect(page.locator("#benchmarkTable")).toContainText("claude-sonnet-4-5");
  });
});
