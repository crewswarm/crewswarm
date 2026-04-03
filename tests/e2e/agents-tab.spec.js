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
  const isActive = await page.locator(`#${viewId}`).evaluate(
    (el) => el.classList.contains("active") || el.style.display !== "none",
  ).catch(() => false);
  if (!isActive) {
    const dataView = await page.locator(`#${navId}`).getAttribute("data-view");
    if (dataView) await page.evaluate((v) => { window.location.hash = v; }, dataView);
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

const fixtureAgents = {
  ok: true,
  allModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5", "google/gemini-2.5-flash"],
  modelsByProvider: {
    openai: [{ id: "gpt-5.4", name: "gpt-5.4" }],
    anthropic: [{ id: "claude-sonnet-4-5", name: "claude-sonnet-4-5" }],
    google: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
  },
  agents: [
    {
      id: "crew-coder",
      model: "openai/gpt-5.4",
      fallbackModel: "",
      name: "crew-coder",
      emoji: "🤖",
      alsoAllow: ["write_file"],
      useOpenCode: false,
      useCursorCli: false,
      useClaudeCode: false,
      useCodex: false,
      useGeminiCli: false,
      useCrewCLI: false,
      useDockerSandbox: false,
      opencodeLoop: false,
      opencodeLoopMaxRounds: 10,
    },
  ],
};

const fixtureEngines = {
  engines: [
    { id: "codex", label: "Codex CLI", ready: true, color: "#a855f7" },
    { id: "cursor", label: "Cursor CLI", ready: true, color: "#38bdf8" },
    { id: "crew-cli", label: "crew-cli", ready: true, color: "#10b981" },
  ],
};

test.describe("Agents tab engine settings", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await page.route("**/api/agents-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtureAgents),
      });
    });
    await page.route("**/api/engines", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtureEngines),
      });
    });
    await page.route("**/api/opencode-models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: [] }),
      });
    });
    await waitForDashboardHealth(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("route button posts mutually-exclusive engine flags", async ({ page }) => {
    let payload = null;
    await page.route("**/api/agents-config/update", async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navAgents", "agentsView");
    await page.locator('#agent-card-crew-coder button[data-action="toggleAgentBody"]').click();
    await page.locator("#route-codex-crew-coder").click();

    await expect.poll(() => payload).not.toBeNull();
    expect(payload).toMatchObject({
      agentId: "crew-coder",
      useCodex: true,
      useOpenCode: false,
      useCursorCli: false,
      useClaudeCode: false,
      useGeminiCli: false,
      useCrewCLI: false,
    });
    await expect(page.locator("#codex-model-row-crew-coder")).toBeVisible();
  });

  test("saving codex model posts the exact per-agent model field", async ({ page }) => {
    const requests = [];
    await page.route("**/api/agents-config/update", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navAgents", "agentsView");
    await page.locator('#agent-card-crew-coder button[data-action="toggleAgentBody"]').click();
    await page.locator("#route-codex-crew-coder").click();
    await page.fill("#codex-model-txt-crew-coder", "gpt-5.4");
    await page.locator('button[data-action="saveCodexConfig"][data-arg="crew-coder"]').click();

    await expect.poll(() => requests.length).toBeGreaterThan(1);
    expect(requests.at(-1)).toEqual({
      agentId: "crew-coder",
      codexModel: "gpt-5.4",
    });
  });
});
