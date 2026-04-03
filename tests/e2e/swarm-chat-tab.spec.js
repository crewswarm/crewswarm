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

const PROJECTS_FIXTURE = {
  projects: [
    { id: "general", name: "General" },
    { id: "proj-alpha", name: "Alpha Project" },
  ],
};

const HISTORY_FIXTURE = {
  messages: [
    {
      id: "msg-001",
      ts: Date.now() - 120_000,
      source: "dashboard",
      role: "user",
      content: "Can you help me plan the sprint?",
      agent: null,
      metadata: { agentName: "You", agentEmoji: "👤" },
    },
    {
      id: "msg-002",
      ts: Date.now() - 60_000,
      source: "dashboard",
      role: "assistant",
      content: "Sure! Here is the sprint plan...",
      agent: "crew-lead",
      metadata: { agentName: "crew-lead", agentEmoji: "🧠" },
    },
  ],
};

const PARTICIPANTS_FIXTURE = {
  participants: [
    { id: "crew-lead", kind: "agent", runtime: null },
    { id: "crew-coder", kind: "agent", runtime: null },
    { id: "crew-qa", kind: "agent", runtime: null },
    { id: "codex", kind: "cli", runtime: "codex" },
  ],
};

const AUTONOMY_ENABLED_FIXTURE = { enabled: true };
const AUTONOMY_DISABLED_FIXTURE = { enabled: false };

const UNIFIED_REPLY_FIXTURE = {
  reply: "I understand. Let me coordinate the team.",
  agent: "crew-lead",
  agentName: "crew-lead",
  agentEmoji: "🧠",
};

// ---------------------------------------------------------------------------
// Suite: Swarm Chat tab
// ---------------------------------------------------------------------------

test.describe("Swarm Chat tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/projects", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROJECTS_FIXTURE),
      });
    });

    await page.route(
      "**/api/crew-lead/project-messages**",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(HISTORY_FIXTURE),
        });
      }
    );

    await page.route(
      "**/api/settings/autonomous-mentions",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(AUTONOMY_ENABLED_FIXTURE),
        });
      }
    );

    await page.route("**/api/chat-participants", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PARTICIPANTS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Swarm Chat tab and swarmChatView becomes active", async ({
    page,
  }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");
    await expect(page.locator("#swarmChatView")).toBeVisible();
  });

  test("chat input and send button are visible", async ({ page }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");

    await expect(page.locator("#swarmChatInput")).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.locator("#swarmChatSend")).toBeVisible({
      timeout: 8_000,
    });
  });

  test("chat message history renders on tab open", async ({ page }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");

    const messages = page.locator("#swarmChatMessages");
    await expect(messages).toBeVisible({ timeout: 8_000 });
    await expect(messages).toContainText(
      "Can you help me plan the sprint?",
      { timeout: 8_000 }
    );
    await expect(messages).toContainText(
      "Sure! Here is the sprint plan",
      { timeout: 8_000 }
    );
  });

  test("project selector dropdown renders with fetched projects", async ({
    page,
  }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");

    const select = page.locator("#swarmChatProject");
    await expect(select).toBeVisible({ timeout: 8_000 });
    await expect(
      select.locator("option[value='general']")
    ).toHaveCount(1);
    await expect(
      select.locator("option[value='proj-alpha']")
    ).toHaveCount(1);
  });

  test("autonomy button shows ON state when autonomy is enabled", async ({
    page,
  }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");

    const autonomyBtn = page.locator("#swarmAutonomyBtn");
    await expect(autonomyBtn).toBeVisible({ timeout: 8_000 });
    await expect(autonomyBtn).toContainText("Auto ON", { timeout: 8_000 });
  });

  test("autonomy button shows OFF state when autonomy is disabled", async ({
    page,
  }) => {
    await page.route(
      "**/api/settings/autonomous-mentions",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(AUTONOMY_DISABLED_FIXTURE),
        });
      }
    );

    await openTab(page, "navSwarmChat", "swarmChatView");

    const autonomyBtn = page.locator("#swarmAutonomyBtn");
    await expect(autonomyBtn).toContainText("Auto OFF", { timeout: 8_000 });
  });

  test("clicking autonomy button toggles the setting via POST", async ({
    page,
  }) => {
    const postBodies = [];
    await page.route(
      "**/api/settings/autonomous-mentions",
      async (route) => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          postBodies.push(body);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ enabled: false }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(AUTONOMY_ENABLED_FIXTURE),
          });
        }
      }
    );

    await openTab(page, "navSwarmChat", "swarmChatView");

    const autonomyBtn = page.locator("#swarmAutonomyBtn");
    await expect(autonomyBtn).toBeVisible({ timeout: 8_000 });
    await autonomyBtn.click();
    await page.waitForTimeout(600);

    expect(postBodies.length).toBe(1);
    expect(postBodies[0]).toHaveProperty("enabled", false);
  });

  test("sending a message posts to /api/chat/unified and appends to thread", async ({
    page,
  }) => {
    const unifiedRequests = [];
    await page.route("**/api/chat/unified", async (route) => {
      const body = route.request().postDataJSON();
      unifiedRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UNIFIED_REPLY_FIXTURE),
      });
    });

    await openTab(page, "navSwarmChat", "swarmChatView");

    const input = page.locator("#swarmChatInput");
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.fill("Deploy the hotfix please");

    await page.locator("#swarmChatSend").click();
    await page.waitForTimeout(800);

    // User message should appear in the thread
    const messages = page.locator("#swarmChatMessages");
    await expect(messages).toContainText(
      "Deploy the hotfix please",
      { timeout: 8_000 }
    );

    // API call should have been made
    expect(unifiedRequests.length).toBeGreaterThanOrEqual(1);
    expect(unifiedRequests[0]).toHaveProperty("message", "Deploy the hotfix please");
    expect(unifiedRequests[0]).toHaveProperty("channelMode", true);
  });

  test("pressing Enter in input triggers send", async ({ page }) => {
    const unifiedRequests = [];
    await page.route("**/api/chat/unified", async (route) => {
      const body = route.request().postDataJSON();
      unifiedRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UNIFIED_REPLY_FIXTURE),
      });
    });

    await openTab(page, "navSwarmChat", "swarmChatView");

    const input = page.locator("#swarmChatInput");
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.fill("Kick off nightly build");
    await input.press("Enter");
    await page.waitForTimeout(800);

    expect(unifiedRequests.length).toBeGreaterThanOrEqual(1);
    expect(unifiedRequests[0]).toHaveProperty("message", "Kick off nightly build");
  });

  test("empty input does not trigger API call", async ({ page }) => {
    const unifiedRequests = [];
    await page.route("**/api/chat/unified", async (route) => {
      unifiedRequests.push(true);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UNIFIED_REPLY_FIXTURE),
      });
    });

    await openTab(page, "navSwarmChat", "swarmChatView");

    const input = page.locator("#swarmChatInput");
    await expect(input).toBeVisible({ timeout: 8_000 });
    // Leave input empty
    await input.fill("");
    await page.locator("#swarmChatSend").click();
    await page.waitForTimeout(500);

    expect(unifiedRequests.length).toBe(0);
  });

  test("@mention autocomplete appears after typing @", async ({ page }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");

    const input = page.locator("#swarmChatInput");
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.fill("@crew");
    // Trigger the input event so autocomplete fires
    await input.dispatchEvent("input");
    await page.waitForTimeout(600);

    const menu = page.locator("#swarmMentionMenu");
    await expect(menu).toBeVisible({ timeout: 6_000 });
    // crew-lead, crew-coder, crew-qa should show up
    await expect(menu).toContainText("crew-lead", { timeout: 4_000 });
  });

  test("selecting an @mention autocomplete item fills the input", async ({
    page,
  }) => {
    await openTab(page, "navSwarmChat", "swarmChatView");

    const input = page.locator("#swarmChatInput");
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.fill("@crew-l");
    await input.dispatchEvent("input");
    await page.waitForTimeout(600);

    const menu = page.locator("#swarmMentionMenu");
    await expect(menu).toBeVisible({ timeout: 6_000 });

    const leadOption = menu.locator("div", { hasText: "@crew-lead" }).first();
    await expect(leadOption).toBeVisible({ timeout: 4_000 });
    await leadOption.click();

    // Input should now contain @crew-lead
    await expect(input).toHaveValue(/^@crew-lead\s/, { timeout: 4_000 });
  });

  test("switching projects reloads swarm history", async ({ page }) => {
    const historyUrls = [];
    await page.route(
      "**/api/crew-lead/project-messages**",
      async (route) => {
        historyUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [] }),
        });
      }
    );

    await openTab(page, "navSwarmChat", "swarmChatView");

    const select = page.locator("#swarmChatProject");
    await expect(select).toBeVisible({ timeout: 8_000 });
    await select.selectOption("proj-alpha");
    await page.waitForTimeout(600);

    const alphaRequest = historyUrls.find((url) =>
      url.includes("proj-alpha")
    );
    expect(alphaRequest).toBeDefined();
  });

  test("refresh button reloads projects and history", async ({ page }) => {
    let callCount = 0;
    await page.route(
      "**/api/crew-lead/project-messages**",
      async (route) => {
        callCount++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [] }),
        });
      }
    );

    await openTab(page, "navSwarmChat", "swarmChatView");
    const callsBeforeRefresh = callCount;

    const refreshBtn = page.locator("#swarmChatRefresh");
    await expect(refreshBtn).toBeVisible({ timeout: 8_000 });
    await refreshBtn.click();
    await page.waitForTimeout(600);

    expect(callCount).toBeGreaterThan(callsBeforeRefresh);
  });

  test("multi-agent replies append multiple bubbles to thread", async ({
    page,
  }) => {
    await page.route("**/api/chat/unified", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          replies: [
            {
              agent: "crew-lead",
              agentName: "crew-lead",
              agentEmoji: "🧠",
              reply: "Lead acknowledges the request.",
            },
            {
              agent: "crew-coder",
              agentName: "crew-coder",
              agentEmoji: "🤖",
              reply: "Coder will start the implementation.",
            },
          ],
        }),
      });
    });

    await openTab(page, "navSwarmChat", "swarmChatView");

    const input = page.locator("#swarmChatInput");
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.fill("@crew-lead @crew-coder build the feature");
    await page.locator("#swarmChatSend").click();
    await page.waitForTimeout(1_000);

    const messages = page.locator("#swarmChatMessages");
    await expect(messages).toContainText(
      "Lead acknowledges the request.",
      { timeout: 8_000 }
    );
    await expect(messages).toContainText(
      "Coder will start the implementation.",
      { timeout: 8_000 }
    );
  });
});
