import { test, expect } from "@playwright/test";
import { setupConsoleErrorCapture, expectNoConsoleErrors } from "./helpers.mjs";

const VIBE_URL = "http://127.0.0.1:3333";

async function waitForVibe(page) {
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get(`${VIBE_URL}/api/studio/projects`, {
            timeout: 5_000,
          });
          return response.ok();
        } catch {
          return false;
        }
      },
      { timeout: 30_000, message: "Vibe studio API must be reachable" },
    )
    .toBeTruthy();
}

async function openVibe(page) {
  await page.goto(VIBE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await expect(page.locator("#projectSelector")).toBeVisible({ timeout: 15_000 });
}

test.describe("Vibe routing and chat surfaces", () => {
  test.beforeEach(async ({ page }) => {
    setupConsoleErrorCapture(page);
    await waitForVibe(page);

    await page.route("**/api/studio/projects", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [
            { id: "general", name: "General Chat" },
            { id: "e2e-workspace", name: "Vibe Workspace" },
            { id: "e2e-demo", name: "Demo Project" },
          ],
        }),
      });
    });

    await page.route("**/api/studio/active-project", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ projectId: "e2e-workspace" }),
      });
    });

    await page.route("**/api/agents", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "crew-coder", name: "crew-coder", emoji: "🤖" },
          { id: "crew-pm", name: "crew-pm", emoji: "📋" },
        ]),
      });
    });

    await page.route("**/api/studio/list-files**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [
            { name: "README.md", path: "README.md", type: "file" },
            { name: "src", path: "src", type: "directory" },
            { name: "main.js", path: "src/main.js", type: "file" },
          ],
        }),
      });
    });

    await page.route("**/api/studio/file-content**", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          content: "# Demo\n\nconsole.log('hello from vibe');\n",
        }),
      });
    });

    await page.route("**/api/studio/project-messages**", async (route) => {
      const url = new URL(route.request().url());
      const projectId = url.searchParams.get("projectId");
      const projectMessages = {
        general: [{ role: "assistant", content: "General history", ts: new Date().toISOString() }],
        "e2e-workspace": [{ role: "assistant", content: "Workspace history", ts: new Date().toISOString() }],
        "e2e-demo": [{ role: "assistant", content: "Demo project history", ts: new Date().toISOString() }],
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          messages: projectMessages[projectId || "general"] || [],
        }),
      });
    });

    await page.route("**/api/chat/unified", async (route) => {
      const payload = route.request().postDataJSON();
      const reply =
        payload?.agentId === "crew-coder"
          ? "crew-coder accepted the task"
          : "crew-lead acknowledged the message";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "chunk", text: reply })}\n\ndata: ${JSON.stringify({ type: "done", exitCode: 0, transcript: reply })}\n\n`,
      });
    });
  });

  test.afterEach(async () => {
    expectNoConsoleErrors();
  });

  test("project selector loads workspace files and swaps chat history", async ({ page }) => {
    await openVibe(page);

    const projectSelector = page.locator("#projectSelector");
    await expect
      .poll(
        async () => {
          const values = await projectSelector.locator("option").evaluateAll((opts) =>
            opts.map((opt) => opt.value).filter(Boolean),
          );
          return values;
        },
        { timeout: 15_000 },
      )
      .toEqual(expect.arrayContaining(["general", "e2e-workspace", "e2e-demo"]));

    await projectSelector.selectOption("e2e-workspace");
    await expect(page.locator("#file-tree")).toContainText("README.md");
    await expect(page.locator("#chat-messages")).toContainText("Workspace history");

    await projectSelector.selectOption("e2e-demo");
    await expect(page.locator("#chat-messages")).toContainText("Demo project history");
    await expect(page.locator("#chat-messages")).not.toContainText("Workspace history");
  });

  test("agent and cli chat modes can send deterministic messages", async ({ page }) => {
    await openVibe(page);
    await page.locator("#projectSelector").selectOption("e2e-workspace");

    const modeSelector = page.locator("#chat-mode-selector");
    await expect(modeSelector).toBeVisible();
    await expect(modeSelector.locator("option")).toContainText(["crew-coder"]);

    await modeSelector.selectOption("crew-coder");
    await page.fill("#chat-input", "Implement auth middleware");
    await page.press("#chat-input", "Enter");

    await expect(page.locator("#chat-messages")).toContainText("Implement auth middleware");
    await expect(page.locator("#chat-messages")).toContainText("crew-coder accepted the task");

    await modeSelector.selectOption("crew-lead");
    await page.fill("#chat-input", "Summarize current progress");
    await page.press("#chat-input", "Enter");

    await expect(page.locator("#chat-messages")).toContainText("crew-lead acknowledged the message");
  });
});
