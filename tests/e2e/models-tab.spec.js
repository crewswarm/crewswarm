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
// Common API stubs used across models-tab suites
// ---------------------------------------------------------------------------

async function stubModelsApis(page) {
  await page.route("**/api/settings/rt-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: null }),
    });
  });

  await page.route("**/api/providers/builtin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        keys: {
          groq: "gsk_fake",
          openai: null,
          ollama: null,
        },
      }),
    });
  });

  await page.route("**/api/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [] }),
    });
  });

  await page.route("**/api/oauth/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: {
          "anthropic-oauth": true,
          "openai-oauth": false,
        },
      }),
    });
  });

  await page.route("**/api/oauth/model", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: {
            claudeOauthModel: "claude-sonnet-4-6",
            openaiOauthModel: "gpt-5.4",
          },
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
  });

  await page.route("**/api/search-tools", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ keys: { brave: "bsf_fake", parallel: null } }),
    });
  });
}

// ---------------------------------------------------------------------------
// Suite: Models tab — navigation and layout
// ---------------------------------------------------------------------------

test.describe("Models tab — navigation and layout", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubModelsApis(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Models tab and view becomes active", async ({ page }) => {
    await openTab(page, "navModels", "modelsView");
    await expect(page.locator("#modelsView")).toBeVisible();
  });

  test("builtin providers list renders after API response", async ({ page }) => {
    await openTab(page, "navModels", "modelsView");

    const list = page.locator("#builtinProvidersList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    // Groq is in the builtin list
    await expect(list).toContainText("Groq", { timeout: 8_000 });
  });

  test("OAuth providers section renders Anthropic and OpenAI entries", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const oauthList = page.locator("#oauthProvidersList");
    await expect(oauthList).toBeVisible({ timeout: 8_000 });
    await expect(oauthList).toContainText("Anthropic", { timeout: 8_000 });
    await expect(oauthList).toContainText("OpenAI", { timeout: 8_000 });
  });

  test("search tools section renders Brave and Parallel entries", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const stList = page.locator("#searchToolsList");
    await expect(stList).toBeVisible({ timeout: 8_000 });
    await expect(stList).toContainText("Brave Search", { timeout: 8_000 });
    await expect(stList).toContainText("Parallel", { timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Models tab — OAuth provider section
// ---------------------------------------------------------------------------

test.describe("Models tab — OAuth provider section", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubModelsApis(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("Anthropic OAuth card shows 'connected' badge when status is true", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const oauthList = page.locator("#oauthProvidersList");
    await expect(oauthList).toBeVisible({ timeout: 8_000 });
    // Anthropic is connected in the fixture → should show connected badge
    await expect(oauthList).toContainText("connected", { timeout: 8_000 });
  });

  test("OpenAI OAuth card shows 'not logged in' badge when status is false", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const oauthList = page.locator("#oauthProvidersList");
    await expect(oauthList).toBeVisible({ timeout: 8_000 });
    await expect(oauthList).toContainText("not logged in", { timeout: 8_000 });
  });

  test("Anthropic OAuth model dropdown pre-selects configured model", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const oauthList = page.locator("#oauthProvidersList");
    await expect(oauthList).toBeVisible({ timeout: 8_000 });

    const modelSelect = page.locator("#oa_model_anthropic-oauth");
    await expect(modelSelect).toBeAttached({ timeout: 8_000 });
    await expect(modelSelect).toHaveValue("claude-sonnet-4-6");
  });

  test("OpenAI OAuth model dropdown pre-selects configured model", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const modelSelect = page.locator("#oa_model_openai-oauth");
    await expect(modelSelect).toBeAttached({ timeout: 8_000 });
    await expect(modelSelect).toHaveValue("gpt-5.4");
  });

  test("Save button in OAuth card POSTs to /api/oauth/model", async ({
    page,
  }) => {
    const saveRequests = [];

    await page.route("**/api/oauth/model", async (route) => {
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
          body: JSON.stringify({
            models: {
              claudeOauthModel: "claude-sonnet-4-6",
              openaiOauthModel: "gpt-5.4",
            },
          }),
        });
      }
    });

    await openTab(page, "navModels", "modelsView");

    const oauthList = page.locator("#oauthProvidersList");
    await expect(oauthList).toBeVisible({ timeout: 8_000 });

    // Change model selection then save
    const modelSelect = page.locator("#oa_model_anthropic-oauth");
    await expect(modelSelect).toBeAttached({ timeout: 8_000 });
    await modelSelect.selectOption("claude-haiku-4-5-20251001");

    const saveBtn = oauthList
      .locator("[data-action='saveOauthModel'][data-arg='anthropic-oauth']")
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await saveBtn.click();

    await page.waitForTimeout(600);
    expect(saveRequests.length).toBeGreaterThanOrEqual(1);
    expect(saveRequests[0]).toHaveProperty(
      "claudeOauthModel",
      "claude-haiku-4-5-20251001"
    );
  });

  test("Test button in OAuth card POSTs to /api/oauth/test", async ({
    page,
  }) => {
    const testRequests = [];

    await page.route("**/api/oauth/test", async (route) => {
      testRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, response: "Hello!" }),
      });
    });

    await openTab(page, "navModels", "modelsView");

    const oauthList = page.locator("#oauthProvidersList");
    await expect(oauthList).toBeVisible({ timeout: 8_000 });

    const testBtn = oauthList
      .locator("[data-action='testOauthProvider'][data-arg='anthropic-oauth']")
      .first();
    await expect(testBtn).toBeVisible({ timeout: 8_000 });
    await testBtn.click();

    await page.waitForTimeout(600);
    expect(testRequests.length).toBe(1);
    expect(testRequests[0]).toHaveProperty("providerId", "anthropic-oauth");
  });
});

// ---------------------------------------------------------------------------
// Suite: Models tab — builtin provider key management
// ---------------------------------------------------------------------------

test.describe("Models tab — builtin provider key management", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubModelsApis(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("builtin provider with a saved key shows 'set' status badge", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const list = page.locator("#builtinProvidersList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    // Groq has a key in the fixture → should show a green badge
    await expect(list).toContainText("set ✓", { timeout: 8_000 });
  });

  test("builtin provider without a key shows 'no key' status badge", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const list = page.locator("#builtinProvidersList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    // OpenAI has no key in the fixture
    await expect(list).toContainText("no key", { timeout: 8_000 });
  });

  test("Ollama card shows 'local' badge (no key required)", async ({ page }) => {
    await openTab(page, "navModels", "modelsView");

    const list = page.locator("#builtinProvidersList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("Ollama", { timeout: 8_000 });
    await expect(list).toContainText("local", { timeout: 8_000 });
  });

  test("saving a builtin provider key POSTs to /api/providers/builtin/save", async ({
    page,
  }) => {
    const saveRequests = [];

    await page.route("**/api/providers/builtin/save", async (route) => {
      saveRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.route("**/api/providers/fetch-models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] }),
      });
    });

    await openTab(page, "navModels", "modelsView");

    const list = page.locator("#builtinProvidersList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // Fill the openai key field (its input id is bp_openai)
    const keyInput = page.locator("#bp_openai");
    await expect(keyInput).toBeAttached({ timeout: 8_000 });
    await keyInput.fill("sk-test-fake-key-9999");

    const saveBtn = list
      .locator("[data-action='saveBuiltinKey'][data-arg='openai']")
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await saveBtn.click();

    await page.waitForTimeout(600);
    expect(saveRequests.length).toBe(1);
    expect(saveRequests[0]).toHaveProperty("providerId", "openai");
    expect(saveRequests[0]).toHaveProperty("apiKey", "sk-test-fake-key-9999");
  });

  test("test connection button for builtin provider POSTs to /api/providers/builtin/test", async ({
    page,
  }) => {
    const testRequests = [];

    await page.route("**/api/providers/builtin/test", async (route) => {
      testRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, model: "groq-llama3" }),
      });
    });

    await openTab(page, "navModels", "modelsView");

    const list = page.locator("#builtinProvidersList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    const testBtn = list
      .locator("[data-action='testBuiltinProvider'][data-arg='groq']")
      .first();
    await expect(testBtn).toBeVisible({ timeout: 8_000 });
    await testBtn.click();

    await page.waitForTimeout(600);
    expect(testRequests.length).toBe(1);
    expect(testRequests[0]).toHaveProperty("providerId", "groq");
  });
});

// ---------------------------------------------------------------------------
// Suite: Models tab — search tools
// ---------------------------------------------------------------------------

test.describe("Models tab — search tools", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubModelsApis(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("Brave Search shows 'set' badge when key is present", async ({
    page,
  }) => {
    await openTab(page, "navModels", "modelsView");

    const stList = page.locator("#searchToolsList");
    await expect(stList).toBeVisible({ timeout: 8_000 });
    await expect(stList).toContainText("set ✓", { timeout: 8_000 });
  });

  test("Parallel shows 'no key' badge when key is absent", async ({ page }) => {
    await openTab(page, "navModels", "modelsView");

    const stList = page.locator("#searchToolsList");
    await expect(stList).toBeVisible({ timeout: 8_000 });
    await expect(stList).toContainText("no key", { timeout: 8_000 });
  });

  test("saving a search tool key POSTs to /api/search-tools/save", async ({
    page,
  }) => {
    const saveRequests = [];

    await page.route("**/api/search-tools/save", async (route) => {
      saveRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navModels", "modelsView");

    const stList = page.locator("#searchToolsList");
    await expect(stList).toBeVisible({ timeout: 8_000 });

    const keyInput = page.locator("#st_parallel");
    await expect(keyInput).toBeAttached({ timeout: 8_000 });
    await keyInput.fill("parallel-key-xyz");

    const saveBtn = stList
      .locator("[data-action='saveSearchTool'][data-arg='parallel']")
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await saveBtn.click();

    await page.waitForTimeout(600);
    expect(saveRequests.length).toBe(1);
    expect(saveRequests[0]).toHaveProperty("toolId", "parallel");
    expect(saveRequests[0]).toHaveProperty("key", "parallel-key-xyz");
  });
});
