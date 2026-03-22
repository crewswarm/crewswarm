import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { __setPlaywrightForTests, closeBrowser } from "../../lib/tools/browser.mjs";
import { executeToolCalls } from "../../lib/tools/executor.mjs";

function createMockPlaywright() {
  return {
    chromium: {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          title: async () => "Example Domain",
          waitForSelector: async (selector) => {
            if (selector === ".missing") throw new Error("selector not found");
          },
          click: async () => {},
          fill: async () => {},
          screenshot: async ({ path }) => {
            fs.writeFileSync(path, "mock image", "utf8");
          },
          close: async () => {},
        }),
        close: async () => {},
      }),
    },
  };
}

afterEach(async () => {
  await closeBrowser();
  __setPlaywrightForTests(null);
  delete process.env.CREWSWARM_DISABLE_AUTOHARNESS;
});

describe("@@BROWSER tool execution", () => {
  test("navigates with a mocked Playwright runtime", async () => {
    __setPlaywrightForTests(createMockPlaywright());
    const results = await executeToolCalls(
      "@@BROWSER navigate https://example.com",
      "crew-coder-back",
      { projectId: "test-browser" }
    );

    assert.match(results.join("\n"), /\[tool:browser\] ✅ navigate https:\/\/example\.com/);
    assert.match(results.join("\n"), /title="Example Domain"/);
    assert.match(results.join("\n"), /screenshot=.*\.png/);
  });

  test("parses quoted text for type commands", async () => {
    __setPlaywrightForTests(createMockPlaywright());
    const results = await executeToolCalls(
      '@@BROWSER type https://example.com input[name="q"] "crewswarm"',
      "crew-coder-back",
      { projectId: "test-browser" }
    );

    assert.match(results.join("\n"), /\[tool:browser\] ✅ type https:\/\/example\.com/);
    assert.match(results.join("\n"), /text="crewswarm"/);
  });

  test("supports screenshot actions", async () => {
    __setPlaywrightForTests(createMockPlaywright());
    const results = await executeToolCalls(
      "@@BROWSER screenshot https://example.com",
      "crew-coder-back",
      { projectId: "test-browser" }
    );

    assert.match(results.join("\n"), /\[tool:browser\] ✅ screenshot https:\/\/example\.com/);
    assert.match(results.join("\n"), /file=.*\.png/);
  });

  test("surfaces selector failures cleanly", async () => {
    __setPlaywrightForTests(createMockPlaywright());
    const results = await executeToolCalls(
      "@@BROWSER click https://example.com .missing",
      "crew-coder-back",
      { projectId: "test-browser" }
    );

    assert.match(results.join("\n"), /\[tool:browser\] ❌ click \.missing failed: selector not found/);
  });

  test("rejects browser access for agents without browser permission", async () => {
    __setPlaywrightForTests(createMockPlaywright());
    const results = await executeToolCalls(
      "@@BROWSER navigate https://example.com",
      "crew-pm",
      { projectId: "test-browser" }
    );

    assert.match(results.join("\n"), /\[tool:browser\] ⛔ crew-pm does not have browser permission/);
  });

  test("skips autoharness traces when explicitly disabled", async () => {
    __setPlaywrightForTests(createMockPlaywright());
    process.env.CREWSWARM_DISABLE_AUTOHARNESS = "1";

    const projectId = `test-browser-disabled-${Date.now()}`;
    const traceFile = path.join(
      os.tmpdir(),
      "crewswarm-autoharness",
      "traces",
      "crew-coder-back",
      `${projectId}.tools.jsonl`
    );
    fs.rmSync(traceFile, { force: true });

    const results = await executeToolCalls(
      "@@BROWSER navigate https://example.com",
      "crew-coder-back",
      { projectId }
    );

    assert.match(results.join("\n"), /\[tool:browser\] ✅ navigate https:\/\/example\.com/);
    assert.equal(fs.existsSync(traceFile), false);
  });
});
