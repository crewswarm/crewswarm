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

const TG_STATUS_RUNNING = { running: true, botName: "crewswarm_bot" };
const TG_STATUS_STOPPED = { running: false };

const WA_STATUS_RUNNING = { running: true, number: "14155551234", authSaved: true };
const WA_STATUS_STOPPED = { running: false, authSaved: false };

const TG_CONFIG_FIXTURE = {
  token: "123456:ABCDEF_testtoken",
  allowedChatIds: [111222333, 444555666],
  contactNames: {
    "111222333": "Alice",
    "444555666": "Bob",
  },
  userRouting: {
    "111222333": "crew-main",
  },
  topicRouting: {},
};

const WA_CONFIG_FIXTURE = {
  allowedNumbers: ["+14155551234", "+14155559876"],
  targetAgent: "crew-lead",
  contactNames: { "14155551234": "Jeff" },
  userRouting: {},
};

const TG_MESSAGES_FIXTURE = [
  {
    direction: "inbound",
    ts: new Date("2026-04-02T10:00:00").getTime(),
    firstName: "Alice",
    username: "alice_t",
    text: "Hello crewswarm, run the deployment pipeline",
  },
  {
    direction: "outbound",
    ts: new Date("2026-04-02T10:00:30").getTime(),
    text: "Sure, starting deployment pipeline now...",
  },
];

const WA_MESSAGES_FIXTURE = [
  {
    direction: "inbound",
    ts: new Date("2026-04-02T09:30:00").getTime(),
    jid: "14155551234@s.whatsapp.net",
    text: "What is the project status?",
  },
  {
    direction: "outbound",
    ts: new Date("2026-04-02T09:30:45").getTime(),
    jid: "14155551234@s.whatsapp.net",
    text: "The project is 60% complete with 4 pending tasks.",
  },
];

const TG_SESSIONS_FIXTURE = [
  {
    chatId: 111222333,
    messageCount: 8,
    lastTs: Date.now() - 5 * 60 * 1000,
    messages: [
      { role: "user", content: "Hello crewswarm" },
      { role: "assistant", content: "Hello! How can I help?" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Shared stub setup helper
// ---------------------------------------------------------------------------

async function stubCommsEndpoints(page, opts = {}) {
  const tgStatus = opts.tgStatus || TG_STATUS_RUNNING;
  const waStatus = opts.waStatus || WA_STATUS_RUNNING;

  await page.route("**/api/telegram/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(tgStatus),
    });
  });
  await page.route("**/api/telegram/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(TG_CONFIG_FIXTURE),
    });
  });
  await page.route("**/api/telegram/messages", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.tgMessages || TG_MESSAGES_FIXTURE),
    });
  });
  await page.route("**/api/telegram-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.tgSessions || TG_SESSIONS_FIXTURE),
    });
  });
  await page.route("**/api/whatsapp/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(waStatus),
    });
  });
  await page.route("**/api/whatsapp/config", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(WA_CONFIG_FIXTURE),
      });
    } else {
      // POST — save
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
  });
  await page.route("**/api/whatsapp/messages", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.waMessages || WA_MESSAGES_FIXTURE),
    });
  });
}

// ---------------------------------------------------------------------------
// Suite: Comms tab — navigation and status indicators
// ---------------------------------------------------------------------------

test.describe("Comms tab — navigation and status indicators", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubCommsEndpoints(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("navigates to Comms/Settings tab and comms section becomes visible", async ({
    page,
  }) => {
    // The comms tab lives inside Settings. Navigate there via the Settings nav.
    await openTab(page, "navSettings", "settingsView");
    await expect(page.locator("#settingsView")).toBeVisible();
  });

  test("Telegram status badge shows running when bridge is up", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    // Navigate to comms sub-tab if present
    const commsTab = page.locator('[data-settings-tab="comms"], [data-tab="comms"]').first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const badge = page.locator("#tgStatusBadge");
    await expect(badge).toBeVisible({ timeout: 8_000 });
    await expect(badge).toContainText("@crewswarm_bot", { timeout: 8_000 });
    await expect(badge).toHaveClass(/status-active/, { timeout: 4_000 });
  });

  test("WhatsApp status badge shows running with phone number", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page.locator('[data-settings-tab="comms"], [data-tab="comms"]').first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const badge = page.locator("#waStatusBadge");
    await expect(badge).toBeVisible({ timeout: 8_000 });
    await expect(badge).toContainText("14155551234", { timeout: 8_000 });
    await expect(badge).toHaveClass(/status-active/, { timeout: 4_000 });
  });

  test("WhatsApp auth status shows saved message when auth is persisted", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page.locator('[data-settings-tab="comms"], [data-tab="comms"]').first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const authEl = page.locator("#waAuthStatus");
    await expect(authEl).toBeVisible({ timeout: 8_000 });
    await expect(authEl).toContainText("Auth saved", { timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Comms tab — stopped bridges
// ---------------------------------------------------------------------------

test.describe("Comms tab — stopped bridges", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubCommsEndpoints(page, {
      tgStatus: TG_STATUS_STOPPED,
      waStatus: WA_STATUS_STOPPED,
    });
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("Telegram status badge shows stopped when bridge is down", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page.locator('[data-settings-tab="comms"], [data-tab="comms"]').first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const badge = page.locator("#tgStatusBadge");
    await expect(badge).toBeVisible({ timeout: 8_000 });
    await expect(badge).toContainText("stopped", { timeout: 8_000 });
    await expect(badge).toHaveClass(/status-stopped/, { timeout: 4_000 });
  });

  test("WhatsApp status badge shows stopped when bridge is down", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page.locator('[data-settings-tab="comms"], [data-tab="comms"]').first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const badge = page.locator("#waStatusBadge");
    await expect(badge).toBeVisible({ timeout: 8_000 });
    await expect(badge).toContainText("stopped", { timeout: 8_000 });
  });

  test("WhatsApp auth status warns about missing auth when not saved", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page.locator('[data-settings-tab="comms"], [data-tab="comms"]').first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const authEl = page.locator("#waAuthStatus");
    await expect(authEl).toBeVisible({ timeout: 8_000 });
    await expect(authEl).toContainText("No auth saved", { timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Comms tab — Telegram config and controls
// ---------------------------------------------------------------------------

test.describe("Comms tab — Telegram config and controls", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubCommsEndpoints(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  async function navigateToComms(page) {
    await openTab(page, "navSettings", "settingsView");
    const commsTab = page
      .locator('[data-settings-tab="comms"], [data-tab="comms"]')
      .first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }
  }

  test("Telegram token input is populated from config", async ({ page }) => {
    await navigateToComms(page);

    const tokenInput = page.locator("#tgTokenInput");
    await expect(tokenInput).toBeVisible({ timeout: 8_000 });
    await expect(tokenInput).toHaveValue("123456:ABCDEF_testtoken", {
      timeout: 8_000,
    });
  });

  test("Telegram allowed chat IDs field is populated from config", async ({
    page,
  }) => {
    await navigateToComms(page);

    const allowedIds = page.locator("#tgAllowedIds");
    await expect(allowedIds).toBeVisible({ timeout: 8_000 });
    await expect(allowedIds).toHaveValue(/111222333/, { timeout: 8_000 });
    await expect(allowedIds).toHaveValue(/444555666/, { timeout: 8_000 });
  });

  test("contact name rows are rendered for each allowed chat ID", async ({
    page,
  }) => {
    await navigateToComms(page);

    // Contact inputs generated per chat ID: tgContact-<id>
    const aliceInput = page.locator("#tgContact-111222333");
    await expect(aliceInput).toBeVisible({ timeout: 8_000 });
    await expect(aliceInput).toHaveValue("Alice", { timeout: 8_000 });

    const bobInput = page.locator("#tgContact-444555666");
    await expect(bobInput).toBeVisible({ timeout: 8_000 });
    await expect(bobInput).toHaveValue("Bob", { timeout: 8_000 });
  });

  test("per-user routing dropdown reflects saved routing", async ({ page }) => {
    await navigateToComms(page);

    // Alice (111222333) routes to crew-main
    const routeSel = page.locator("#tgRoute-111222333");
    await expect(routeSel).toBeVisible({ timeout: 8_000 });
    await expect(routeSel).toHaveValue("crew-main", { timeout: 8_000 });
  });

  test("Start Telegram bridge button calls POST /api/telegram/start", async ({
    page,
  }) => {
    const startRequests = [];
    await page.route("**/api/telegram/start", async (route) => {
      startRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await navigateToComms(page);

    const startBtn = page.locator("button", { hasText: /start.*telegram/i }).first();
    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await startBtn.click();

    await page.waitForTimeout(600);
    expect(startRequests.length).toBe(1);
  });

  test("Stop Telegram bridge button calls POST /api/telegram/stop", async ({
    page,
  }) => {
    const stopRequests = [];
    await page.route("**/api/telegram/stop", async (route) => {
      stopRequests.push(true);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await navigateToComms(page);

    const stopBtn = page.locator("button", { hasText: /stop.*telegram/i }).first();
    await expect(stopBtn).toBeVisible({ timeout: 8_000 });
    await stopBtn.click();

    await page.waitForTimeout(600);
    expect(stopRequests.length).toBe(1);
  });

  test("Save Telegram config posts to /api/telegram/config with token and IDs", async ({
    page,
  }) => {
    const saveRequests = [];
    await page.route("**/api/telegram/config", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        saveRequests.push(body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(TG_CONFIG_FIXTURE),
        });
      }
    });

    await navigateToComms(page);

    const saveBtn = page.locator("button", { hasText: /save.*telegram/i }).first();
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await saveBtn.click();

    await page.waitForTimeout(600);
    expect(saveRequests.length).toBeGreaterThanOrEqual(1);
    expect(saveRequests[0]).toHaveProperty("token", "123456:ABCDEF_testtoken");
    expect(saveRequests[0].allowedChatIds).toContain(111222333);
  });
});

// ---------------------------------------------------------------------------
// Suite: Comms tab — message history
// ---------------------------------------------------------------------------

test.describe("Comms tab — message history", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubCommsEndpoints(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  async function navigateToComms(page) {
    await openTab(page, "navSettings", "settingsView");
    const commsTab = page
      .locator('[data-settings-tab="comms"], [data-tab="comms"]')
      .first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }
  }

  test("Telegram message feed renders inbound and outbound messages", async ({
    page,
  }) => {
    await navigateToComms(page);

    const feed = page.locator("#tgMessageFeed");
    await expect(feed).toBeVisible({ timeout: 8_000 });
    await expect(feed).toContainText(
      "Hello crewswarm, run the deployment pipeline",
      { timeout: 8_000 }
    );
    await expect(feed).toContainText(
      "Starting deployment pipeline now",
      { timeout: 8_000 }
    );
  });

  test("Telegram message feed shows sender names for inbound messages", async ({
    page,
  }) => {
    await navigateToComms(page);

    const feed = page.locator("#tgMessageFeed");
    await expect(feed).toBeVisible({ timeout: 8_000 });
    await expect(feed).toContainText("Alice", { timeout: 8_000 });
    await expect(feed).toContainText("@alice_t", { timeout: 8_000 });
  });

  test("WhatsApp message feed renders inbound and outbound messages", async ({
    page,
  }) => {
    await navigateToComms(page);

    const feed = page.locator("#waMessageFeed");
    await expect(feed).toBeVisible({ timeout: 8_000 });
    await expect(feed).toContainText("What is the project status?", {
      timeout: 8_000,
    });
    await expect(feed).toContainText("60% complete", { timeout: 8_000 });
  });

  test("WhatsApp message feed shows phone number for inbound messages", async ({
    page,
  }) => {
    await navigateToComms(page);

    const feed = page.locator("#waMessageFeed");
    await expect(feed).toBeVisible({ timeout: 8_000 });
    // jid "14155551234@s.whatsapp.net" → rendered as "+14155551234"
    await expect(feed).toContainText("14155551234", { timeout: 8_000 });
  });

  test("Telegram sessions list renders session cards with message count", async ({
    page,
  }) => {
    await navigateToComms(page);

    const sessions = page.locator("#tgSessionsList");
    await expect(sessions).toBeVisible({ timeout: 8_000 });
    await expect(sessions).toContainText("111222333", { timeout: 8_000 });
    await expect(sessions).toContainText("8 msgs", { timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite: Comms tab — WhatsApp config
// ---------------------------------------------------------------------------

test.describe("Comms tab — WhatsApp config", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubCommsEndpoints(page);
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  async function navigateToComms(page) {
    await openTab(page, "navSettings", "settingsView");
    const commsTab = page
      .locator('[data-settings-tab="comms"], [data-tab="comms"]')
      .first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }
  }

  test("WhatsApp allowed numbers field is populated from config", async ({
    page,
  }) => {
    await navigateToComms(page);

    const numbersEl = page.locator("#waAllowedNumbers");
    await expect(numbersEl).toBeVisible({ timeout: 8_000 });
    await expect(numbersEl).toHaveValue(/\+14155551234/, { timeout: 8_000 });
  });

  test("WhatsApp target agent field defaults to crew-lead", async ({ page }) => {
    await navigateToComms(page);

    const agentEl = page.locator("#waTargetAgent");
    await expect(agentEl).toBeVisible({ timeout: 8_000 });
    await expect(agentEl).toHaveValue("crew-lead", { timeout: 8_000 });
  });

  test("Save WhatsApp config posts to /api/whatsapp/config with numbers and agent", async ({
    page,
  }) => {
    const saveRequests = [];
    await page.route("**/api/whatsapp/config", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        saveRequests.push(body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(WA_CONFIG_FIXTURE),
        });
      }
    });

    await navigateToComms(page);

    const saveBtn = page
      .locator("button", { hasText: /save.*whatsapp/i })
      .first();
    await expect(saveBtn).toBeVisible({ timeout: 8_000 });
    await saveBtn.click();

    await page.waitForTimeout(600);
    expect(saveRequests.length).toBeGreaterThanOrEqual(1);
    expect(saveRequests[0]).toHaveProperty("targetAgent", "crew-lead");
    expect(saveRequests[0].allowedNumbers).toContain("+14155551234");
  });

  test("Start WhatsApp bridge button calls POST /api/whatsapp/start", async ({
    page,
  }) => {
    const startRequests = [];
    await page.route("**/api/whatsapp/start", async (route) => {
      startRequests.push(true);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await navigateToComms(page);

    const startBtn = page
      .locator("button", { hasText: /start.*whatsapp/i })
      .first();
    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await startBtn.click();

    await page.waitForTimeout(600);
    expect(startRequests.length).toBe(1);
  });

  test("Stop WhatsApp bridge button calls POST /api/whatsapp/stop", async ({
    page,
  }) => {
    const stopRequests = [];
    await page.route("**/api/whatsapp/stop", async (route) => {
      stopRequests.push(true);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await navigateToComms(page);

    const stopBtn = page
      .locator("button", { hasText: /stop.*whatsapp/i })
      .first();
    await expect(stopBtn).toBeVisible({ timeout: 8_000 });
    await stopBtn.click();

    await page.waitForTimeout(600);
    expect(stopRequests.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: Comms tab — empty message feeds
// ---------------------------------------------------------------------------

test.describe("Comms tab — empty message feeds", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);
    await stubCommsEndpoints(page, {
      tgMessages: [],
      waMessages: [],
      tgSessions: [],
    });
    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("Telegram feed shows empty state message when no messages exist", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page
      .locator('[data-settings-tab="comms"], [data-tab="comms"]')
      .first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const feed = page.locator("#tgMessageFeed");
    await expect(feed).toBeVisible({ timeout: 8_000 });
    await expect(feed).toContainText("No messages yet", { timeout: 8_000 });
  });

  test("WhatsApp feed shows empty state message when no messages exist", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page
      .locator('[data-settings-tab="comms"], [data-tab="comms"]')
      .first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const feed = page.locator("#waMessageFeed");
    await expect(feed).toBeVisible({ timeout: 8_000 });
    await expect(feed).toContainText("No messages yet", { timeout: 8_000 });
  });

  test("Telegram sessions list shows empty state when no sessions exist", async ({
    page,
  }) => {
    await openTab(page, "navSettings", "settingsView");

    const commsTab = page
      .locator('[data-settings-tab="comms"], [data-tab="comms"]')
      .first();
    if (await commsTab.isVisible().catch(() => false)) {
      await commsTab.click();
      await page.waitForTimeout(400);
    }

    const sessions = page.locator("#tgSessionsList");
    await expect(sessions).toBeVisible({ timeout: 8_000 });
    await expect(sessions).toContainText("No Telegram sessions yet", {
      timeout: 8_000,
    });
  });
});
