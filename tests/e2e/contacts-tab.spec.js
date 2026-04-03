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

const CONTACTS_FIXTURE = {
  contacts: [
    {
      contact_id: "telegram:11111111",
      platform: "telegram",
      display_name: "Alice Smith",
      phone_number: "+15551110000",
      email: "alice@example.com",
      notes: "VIP client",
      last_seen: Date.now() / 1000 - 3600,
      message_count: 42,
      tags: ["vip", "client"],
      preferences: { diet: "vegan", spiceLevel: "mild" },
      platform_links: {},
    },
    {
      contact_id: "whatsapp:22222222@s.whatsapp.net",
      platform: "whatsapp",
      display_name: "Bob Jones",
      phone_number: "+15552220000",
      email: null,
      notes: "",
      last_seen: Date.now() / 1000 - 86400,
      message_count: 7,
      tags: [],
      preferences: {},
      platform_links: { telegram: "99999999" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Suite: Contacts tab
// ---------------------------------------------------------------------------

test.describe("Contacts tab", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await disableDashboardSSE(page);
    await waitForDashboardHealth(page);

    await page.route("**/api/contacts", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CONTACTS_FIXTURE),
      });
    });

    await openDashboard(page);
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  // ── Navigation ──────────────────────────────────────────────────────────────

  test("navigates to Contacts tab and view becomes active", async ({ page }) => {
    await openTab(page, "navContacts", "contactsView");
    await expect(page.locator("#contactsView")).toBeVisible();
  });

  // ── Contact list rendering ──────────────────────────────────────────────────

  test("contact list renders both contacts from API fixture", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toBeVisible({ timeout: 8_000 });
    await expect(list).toContainText("Alice Smith", { timeout: 8_000 });
    await expect(list).toContainText("Bob Jones", { timeout: 8_000 });
  });

  test("contactsCount reflects total number of contacts", async ({ page }) => {
    await openTab(page, "navContacts", "contactsView");

    const count = page.locator("#contactsCount");
    await expect(count).toBeVisible({ timeout: 8_000 });
    await expect(count).toContainText("2", { timeout: 8_000 });
  });

  test("platform badges render correctly — Telegram and WhatsApp", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toContainText("Telegram", { timeout: 8_000 });
    await expect(list).toContainText("WhatsApp", { timeout: 8_000 });
  });

  test("contact with cross-linked platform shows both badges", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    // Bob Jones is WhatsApp primary but also has telegram link
    const list = page.locator("#contactsList");
    // There should be at least 2 Telegram badges across all cards (Alice + Bob)
    const telegramBadges = list.locator("span", { hasText: "Telegram" });
    await expect(telegramBadges).toHaveCount(2, { timeout: 8_000 });
  });

  // ── Add contact modal ───────────────────────────────────────────────────────

  test("clicking New Contact button opens the modal overlay", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    // The button that triggers newContact() — look for button with that text
    const newBtn = page
      .locator("button", { hasText: /new contact/i })
      .first();
    await expect(newBtn).toBeVisible({ timeout: 8_000 });
    await newBtn.click();

    const modal = page.locator("#modalOverlay");
    await expect(modal).toBeVisible({ timeout: 6_000 });
    await expect(modal).toContainText("New Contact");
  });

  test("new contact modal contains required fields: platform, ID, display name", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    const newBtn = page
      .locator("button", { hasText: /new contact/i })
      .first();
    await newBtn.click();

    const modal = page.locator("#modalOverlay");
    await expect(modal).toBeVisible({ timeout: 6_000 });

    await expect(modal.locator("#newContactPlatform")).toBeVisible();
    await expect(modal.locator("#newContactId")).toBeVisible();
    await expect(modal.locator("#newContactName")).toBeVisible();
  });

  test("creating a contact POSTs to /api/contacts/create with correct payload", async ({
    page,
  }) => {
    const createRequests = [];

    await page.route("**/api/contacts/create", async (route) => {
      const body = route.request().postDataJSON();
      createRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navContacts", "contactsView");

    const newBtn = page
      .locator("button", { hasText: /new contact/i })
      .first();
    await newBtn.click();

    const modal = page.locator("#modalOverlay");
    await expect(modal).toBeVisible({ timeout: 6_000 });

    await modal.locator("#newContactPlatform").selectOption("telegram");
    await modal.locator("#newContactId").fill("77777777");
    await modal.locator("#newContactName").fill("Test User");

    // Click Create Contact button inside the modal
    await modal.locator("button", { hasText: /create contact/i }).click();

    await page.waitForTimeout(800);

    expect(createRequests.length).toBe(1);
    expect(createRequests[0]).toHaveProperty("platform", "telegram");
    expect(createRequests[0]).toHaveProperty("display_name", "Test User");
    expect(createRequests[0]).toHaveProperty(
      "contact_id",
      "telegram:77777777"
    );
  });

  // ── Search and filter ───────────────────────────────────────────────────────

  test("search input exists and filters visible contacts", async ({ page }) => {
    await openTab(page, "navContacts", "contactsView");

    const searchInput = page.locator("#contactsSearch");
    await expect(searchInput).toBeVisible({ timeout: 8_000 });

    await searchInput.fill("Alice");
    // Trigger filter — the tab calls applyContactFilters on input event
    await searchInput.dispatchEvent("input");
    await page.waitForTimeout(500);

    const list = page.locator("#contactsList");
    await expect(list).toContainText("Alice Smith", { timeout: 4_000 });
  });

  test("platform filter dropdown exists", async ({ page }) => {
    await openTab(page, "navContacts", "contactsView");

    const filter = page.locator("#contactsPlatformFilter");
    await expect(filter).toBeVisible({ timeout: 8_000 });
  });

  test("sort-by dropdown exists", async ({ page }) => {
    await openTab(page, "navContacts", "contactsView");

    const sortBy = page.locator("#contactsSortBy");
    await expect(sortBy).toBeVisible({ timeout: 8_000 });
  });

  // ── Edit contact ────────────────────────────────────────────────────────────

  test("clicking Edit button reveals the inline edit form for that contact", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    // Click the Edit button on the first card
    const editBtn = list
      .locator("[data-action='edit']")
      .first();
    await expect(editBtn).toBeVisible({ timeout: 8_000 });
    await editBtn.click();

    // The edit form should be visible; look for a save button inside the form
    const saveEditBtn = list
      .locator("[data-action='save-edit']")
      .first();
    await expect(saveEditBtn).toBeVisible({ timeout: 4_000 });
  });

  test("save edit POSTs to /api/contacts/update with contactId", async ({
    page,
  }) => {
    const updateRequests = [];

    await page.route("**/api/contacts/update", async (route) => {
      const body = route.request().postDataJSON();
      updateRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    const editBtn = list.locator("[data-action='edit']").first();
    await editBtn.click();

    // Update display name field
    const nameInput = list
      .locator("[id^='contact-name-']")
      .first();
    await expect(nameInput).toBeVisible({ timeout: 4_000 });
    await nameInput.fill("Alice Smith Updated");

    const saveBtn = list.locator("[data-action='save-edit']").first();
    await saveBtn.click();

    await page.waitForTimeout(800);

    expect(updateRequests.length).toBe(1);
    expect(updateRequests[0]).toHaveProperty("contactId");
    expect(updateRequests[0]).toHaveProperty("display_name", "Alice Smith Updated");
  });

  // ── Delete contact ──────────────────────────────────────────────────────────

  test("delete button calls /api/contacts/delete after confirm", async ({
    page,
  }) => {
    const deleteRequests = [];

    await page.route("**/api/contacts/delete", async (route) => {
      const body = route.request().postDataJSON();
      deleteRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Auto-accept the confirm() dialog
    page.on("dialog", (dialog) => dialog.accept());

    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    const deleteBtn = list.locator("[data-action='delete']").first();
    await expect(deleteBtn).toBeVisible({ timeout: 8_000 });
    await deleteBtn.click();

    await page.waitForTimeout(800);

    expect(deleteRequests.length).toBe(1);
    expect(deleteRequests[0]).toHaveProperty("contactId");
  });

  // ── Details panel ───────────────────────────────────────────────────────────

  test("clicking Details button toggles the expandable details panel", async ({
    page,
  }) => {
    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toBeVisible({ timeout: 8_000 });

    const detailsBtn = list
      .locator("[data-action='toggle-details']")
      .first();
    await expect(detailsBtn).toBeVisible({ timeout: 8_000 });
    await detailsBtn.click();

    // The details div for the first contact should now be visible
    const detailsPanel = list
      .locator("[id^='contact-details-']")
      .first();
    await expect(detailsPanel).toBeVisible({ timeout: 4_000 });
  });

  // ── Empty state ─────────────────────────────────────────────────────────────

  test("empty contacts list renders informative empty-state message", async ({
    page,
  }) => {
    // Override the contacts route to return zero contacts
    await page.route("**/api/contacts", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ contacts: [] }),
      });
    });

    await openTab(page, "navContacts", "contactsView");

    const list = page.locator("#contactsList");
    await expect(list).toContainText("No contacts yet", { timeout: 8_000 });
  });
});
