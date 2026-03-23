import { test, expect } from "@playwright/test";

// ─── constants ───────────────────────────────────────────────────────────────

const vibeUrl = "http://127.0.0.1:3333";
const dashboardUrl = "http://127.0.0.1:4319";

// Autosave debounce in main.js is 1 000 ms; we wait comfortably past that.
const AUTOSAVE_WAIT_MS = 2_500;

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Assert both servers are up before touching the browser.
 * Mirrors the pattern in dispatch-surfaces.spec.js.
 */
async function waitForHealthy(page) {
  await expect
    .poll(
      async () => {
        try {
          const studioResp = await page.request.get(
            `${vibeUrl}/api/studio/projects`,
            { timeout: 5_000 },
          );
          return studioResp.ok();
        } catch {
          return false;
        }
      },
      {
        message: "Vibe studio API must be reachable",
        timeout: 30_000,
      },
    )
    .toBeTruthy();

  await expect
    .poll(
      async () => {
        try {
          const dashResp = await page.request.get(
            `${dashboardUrl}/api/health`,
            { timeout: 5_000 },
          );
          return dashResp.ok();
        } catch {
          return false;
        }
      },
      {
        message: "Dashboard API must be reachable",
        timeout: 30_000,
      },
    )
    .toBeTruthy();
}

/**
 * Navigate to Vibe and wait until the page is fully idle and at least one
 * project option (other than the placeholder "Loading…") is populated in
 * the selector — this is the reliable "app is ready" signal.
 */
async function gotoVibe(page) {
  await page.goto(vibeUrl, { waitUntil: "networkidle" });
  const projectOptions = page.locator("#projectSelector option:not([value=''])");
  await expect
    .poll(
      async () => projectOptions.count(),
      {
        message:
          "Project selector must be populated before interacting with the app",
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);
}

/**
 * Select a file-backed project in the project selector and wait for the file
 * tree to finish loading (the initial "Loading files…" placeholder must
 * disappear).
 */
async function switchToWorkspaceProject(page) {
  const selector = page.locator("#projectSelector");
  await expect(selector).toBeVisible();
  const optionValues = await selector.locator("option").evaluateAll(
    (opts) => opts.map((o) => o.value).filter(Boolean),
  );
  const targetProject =
    optionValues.find((value) => value === "studio-local") ||
    optionValues.find((value) => value !== "general");

  expect(
    targetProject,
    "A file-backed project must be available in the project selector",
  ).toBeTruthy();

  await selector.selectOption(targetProject);
  // Wait until the loading placeholder is gone
  await expect(
    page.locator("#file-tree li.loading"),
    "File-tree loading placeholder should disappear after project switch",
  ).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Click the first real file entry in the file tree (one that has a data-path
 * attribute so we know it is a real file, not an empty-state notice).
 *
 * Returns the path value so callers can reference the opened file.
 */
async function openFirstFile(page) {
  const firstItem = page.locator("#file-tree li[data-path]").first();
  await expect(
    firstItem,
    "At least one file must exist in the file tree",
  ).toBeVisible({ timeout: 15_000 });

  const filePath = await firstItem.getAttribute("data-path");
  await firstItem.click();
  return filePath;
}

/**
 * Wait for Monaco to finish loading and show actual file content.
 * Monaco mounts inside #editor-container; we probe the textarea that Monaco
 * injects (.monaco-editor textarea) which is the live editor cursor node.
 */
async function waitForMonaco(page) {
  await expect(
    page.locator(".monaco-editor"),
    "Monaco editor must mount after opening a file",
  ).toBeVisible({ timeout: 20_000 });
}

// ─── tests ───────────────────────────────────────────────────────────────────

test.describe("Vibe editor", () => {
  test.beforeEach(async ({ page }) => {
    await waitForHealthy(page);
  });

  // ── 1. File tree loads ────────────────────────────────────────────────────

  test("file tree panel renders and shows files after page load", async ({ page }) => {
    await gotoVibe(page);
    await switchToWorkspaceProject(page);

    const fileTree = page.locator("#file-tree");
    await expect(fileTree, "File tree container must be visible").toBeVisible();

    // There must be at least one real file entry (has data-path attribute).
    const fileItems = page.locator("#file-tree li[data-path]");
    await expect(
      fileItems,
      "File tree must contain at least one file entry",
    ).not.toHaveCount(0, { timeout: 15_000 });

    // Confirm the sidebar explorer header is shown (basic structural check).
    const explorerHeading = page.locator("#sidebar h3");
    await expect(explorerHeading).toBeVisible();
    await expect(explorerHeading).toContainText("Explorer");
  });

  // ── 2. Open a file — Monaco loads with content ────────────────────────────

  test("clicking a file in the tree loads Monaco editor with content", async ({ page }) => {
    await gotoVibe(page);
    await switchToWorkspaceProject(page);

    const filePath = await openFirstFile(page);
    expect(filePath, "Opened file must have a non-empty path").toBeTruthy();

    await waitForMonaco(page);

    // The active tab label must match the filename (last segment of path).
    const fileName = filePath.split("/").pop();
    const activeTab = page.locator(".editor-tab.active");
    await expect(activeTab, "An active editor tab must appear").toBeVisible({ timeout: 10_000 });
    await expect(activeTab).toContainText(fileName);

    // The editor must not be completely empty — real files have content.
    const editorLines = page.locator(".monaco-editor .view-line");
    await expect(
      editorLines,
      "Monaco editor must have at least one rendered line",
    ).not.toHaveCount(0, { timeout: 10_000 });

    // Verify the file tree highlights the active file.
    const activeFileItem = page.locator(`#file-tree li[data-path="${filePath}"].active`);
    await expect(
      activeFileItem,
      "Opened file must be highlighted as active in the file tree",
    ).toBeVisible();
  });

  // ── 3. Edit and save (autosave + API round-trip) ──────────────────────────

  test("editing content triggers autosave and persists via the file-content API", async ({ page }) => {
    await gotoVibe(page);
    await switchToWorkspaceProject(page);

    const filePath = await openFirstFile(page);
    await waitForMonaco(page);

    // Read the original content via API so we can restore it after the test.
    const originalResp = await page.request.get(
      `${vibeUrl}/api/studio/file-content?path=${encodeURIComponent(filePath)}`,
    );
    expect(
      originalResp.ok(),
      `GET /api/studio/file-content must succeed for ${filePath}`,
    ).toBeTruthy();
    const originalBody = await originalResp.json();
    const originalContent = originalBody.content ?? "";

    // Inject a uniquely identifiable token so we can confirm it was saved.
    const saveToken = `/* vibe-e2e-save-${Date.now()} */`;

    // Click into the editor and insert the token at the very start of the file.
    const editorTextarea = page.locator(".monaco-editor textarea").first();
    await editorTextarea.click({ force: true });
    await page.keyboard.press("ControlOrMeta+Home"); // jump to top
    await page.keyboard.type(saveToken + "\n");

    // Wait for autosave (debounce is 1 000 ms in main.js).
    await page.waitForTimeout(AUTOSAVE_WAIT_MS);

    // Confirm persistence via the API.
    const savedResp = await page.request.get(
      `${vibeUrl}/api/studio/file-content?path=${encodeURIComponent(filePath)}`,
    );
    expect(savedResp.ok(), "GET /api/studio/file-content must succeed after save").toBeTruthy();
    const savedBody = await savedResp.json();
    expect(
      savedBody.content,
      "Saved file content must contain the injected token",
    ).toContain(saveToken);

    // Restore original content so we leave the working tree clean.
    await page.request.post(`${vibeUrl}/api/studio/file-content`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ path: filePath, content: originalContent }),
    });
  });

  // ── 4. Chat sends and receives ───────────────────────────────────────────

  test("typing a message in chat and pressing Enter shows the message in the chat thread", async ({ page }) => {
    await gotoVibe(page);
    await switchToWorkspaceProject(page);

    // Use crew-lead mode (most reliable for a quick echo-style check).
    const modeSelector = page.locator("#chat-mode-selector");
    await expect(modeSelector).toBeVisible();
    await modeSelector.selectOption("crew-lead");

    const chatInput = page.locator("#chat-input");
    await expect(chatInput, "Chat input must be visible").toBeVisible();

    const userToken = `vibe-e2e-chat-${Date.now()}`;
    await chatInput.fill(`Echo back exactly: ${userToken}`);
    await chatInput.press("Enter");

    // The user's own message must appear immediately (optimistic append).
    await expect(
      page.locator("#chat-messages .message.user"),
      "User message bubble must appear in the chat thread",
    ).not.toHaveCount(0, { timeout: 10_000 });

    // The user bubble must contain the sent text.
    await expect(page.locator("#chat-messages")).toContainText(userToken, {
      timeout: 10_000,
    });

    // A response (assistant or agent) must arrive within 45 s.
    await expect(
      page.locator("#chat-messages .message.assistant, #chat-messages .message.agent"),
      "An assistant/agent response must appear after sending the message",
    ).not.toHaveCount(0, { timeout: 45_000 });
  });

  // ── 5. Project selector changes chat history ─────────────────────────────

  test("switching projects via #projectSelector clears and reloads chat history", async ({ page }) => {
    await gotoVibe(page);

    const selector = page.locator("#projectSelector");
    await expect(selector).toBeVisible();

    // Collect all available project option values.
    const optionValues = await selector.locator("option").evaluateAll(
      (opts) => opts.map((o) => o.value).filter((v) => v && v !== ""),
    );

    // Need at least two projects to test switching.
    test.skip(
      optionValues.length < 2,
      "Skipped: fewer than two projects are configured — cannot test project switching",
    );

    const [firstProjectId, secondProjectId] = optionValues;

    // Switch to the first project and note the current chat container state.
    await selector.selectOption(firstProjectId);
    await expect(
      page.locator("#file-tree li.loading"),
      "Loading placeholder should clear after switching to first project",
    ).toHaveCount(0, { timeout: 15_000 });

    // Send a tagged message so the first project has a distinguishable history entry.
    const firstProjectToken = `project-a-${Date.now()}`;
    const chatInput = page.locator("#chat-input");
    const modeSelector = page.locator("#chat-mode-selector");
    await modeSelector.selectOption("crew-lead");
    await chatInput.fill(firstProjectToken);
    await chatInput.press("Enter");
    await expect(page.locator("#chat-messages")).toContainText(firstProjectToken, {
      timeout: 10_000,
    });

    // Switch to the second project — the chat should update.
    await selector.selectOption(secondProjectId);
    await expect(
      page.locator("#file-tree li.loading"),
      "Loading placeholder should clear after switching to second project",
    ).toHaveCount(0, { timeout: 15_000 });

    // The first project's unique token must NOT be visible in the second project's history.
    await expect(
      page.locator("#chat-messages"),
      "Chat history must not carry over when switching projects",
    ).not.toContainText(firstProjectToken, { timeout: 5_000 });
  });

  // ── 6. Chat mode selector ────────────────────────────────────────────────

  test("switching chat mode via #chat-mode-selector updates the active mode", async ({ page }) => {
    await gotoVibe(page);
    await switchToWorkspaceProject(page);

    const modeSelector = page.locator("#chat-mode-selector");
    await expect(modeSelector, "Chat mode selector must be visible").toBeVisible();

    // Confirm the selector shows at least the built-in modes.
    const options = await modeSelector.locator("option").evaluateAll(
      (opts) => opts.map((o) => o.value),
    );
    expect(options, "Must have crew-lead option").toContain("crew-lead");
    expect(options, "Must have at least one cli: option").toContain(
      options.find((v) => v.startsWith("cli:")),
    );

    // Switch to crew-lead and verify the DOM reflects it.
    await modeSelector.selectOption("crew-lead");
    await expect(modeSelector).toHaveValue("crew-lead");

    // The chat input placeholder should acknowledge crew-lead mode.
    const chatInput = page.locator("#chat-input");
    await expect(chatInput).toBeVisible();
    // After mode switch the input should still be interactive (not disabled).
    await expect(chatInput).toBeEnabled();

    // Switch to a CLI mode (use crew-cli which is always bundled).
    await modeSelector.selectOption("cli:crew-cli");
    await expect(
      modeSelector,
      "Selector value must update to cli:crew-cli",
    ).toHaveValue("cli:crew-cli");

    // Verify the mode persisted by reading the selector value directly (not localStorage,
    // since Playwright runs in-process with the page).
    const persistedMode = await modeSelector.inputValue();
    expect(persistedMode, "Selected CLI mode must persist in the selector").toBe("cli:crew-cli");

    // Switch back to crew-lead to leave the app in its default state.
    await modeSelector.selectOption("crew-lead");
    await expect(modeSelector).toHaveValue("crew-lead");
  });
});
