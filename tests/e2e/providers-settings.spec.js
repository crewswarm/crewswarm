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
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }
  if (lastError) throw lastError;
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

test.describe("Providers and Settings wiring", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await page.route("**/api/providers/builtin", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ keys: {} }),
      });
    });
    await page.route("**/api/providers", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ providers: [] }),
      });
    });
    await page.route("**/api/providers/fetch-models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, models: ["gpt-5.4", "gpt-5.4-mini"] }),
      });
    });
    await page.route("**/api/settings/rt-token", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ token: "saved-token" }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/settings/opencode-project", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dir: "/tmp/demo-project",
            fallbackModel: "groq/kimi-k2-instruct-0905",
            opencodeModel: "openai/gpt-5.4",
            crewLeadModel: "openai/gpt-5.4",
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/agents-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          allModels: ["openai/gpt-5.4", "groq/kimi-k2-instruct-0905"],
          modelsByProvider: {},
          agents: [],
        }),
      });
    });
    await waitForDashboardHealth(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("saving a built-in provider key posts the correct payload", async ({ page }) => {
    const requests = [];
    await page.route("**/api/providers/builtin/save", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navModels", "modelsView");
    await page.locator(".bp-body").first().evaluate((el) => {
      el.style.display = "block";
    });
    await page.locator("#bp_openai").evaluate((el) => {
      el.value = "sk-test-openai";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator('button[data-action="saveBuiltinKey"][data-arg="openai"]').evaluate((el) => {
      el.click();
    });

    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[0]).toEqual({ providerId: "openai", apiKey: "sk-test-openai" });
  });

  test("saving RT token posts to the correct settings endpoint", async ({ page }) => {
    const requests = [];
    await page.route("**/api/settings/rt-token", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ token: "saved-token" }),
        });
        return;
      }
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navModels", "modelsView");
    await page.fill("#rtTokenInput", "rt-test-token");
    await page.locator('button[data-action="saveRTToken"]').click();

    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[0]).toEqual({ token: "rt-test-token" });
  });

  test("saving OpenCode project settings posts dir and fallback model", async ({ page }) => {
    const requests = [];
    await page.route("**/api/settings/opencode-project", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dir: "/tmp/demo-project",
            fallbackModel: "groq/kimi-k2-instruct-0905",
            opencodeModel: "openai/gpt-5.4",
            crewLeadModel: "openai/gpt-5.4",
          }),
        });
        return;
      }
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navSettings", "settingsView");
    await page.locator("#stab-engines").click();
    await expect(page.locator("#stab-panel-engines")).toBeVisible();
    await page.fill("#opencodeProjInput", "/tmp/new-project");
    await page.selectOption("#opencodeFallbackSelect", "groq/kimi-k2-instruct-0905");
    await page.locator('button[data-action="saveOpencodeSettings"]').first().click();

    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[0]).toEqual({
      dir: "/tmp/new-project",
      fallbackModel: "groq/kimi-k2-instruct-0905",
    });
  });
});
