import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

import { executeToolCalls } from "../../lib/tools/executor.mjs";
import { closeBrowser } from "../../lib/tools/browser.mjs";

let server = null;
let baseUrl = "";
let playwrightAvailable = false;
let previousDisableAutoharness = undefined;

try {
  await import("playwright");
  playwrightAvailable = true;
} catch {
  playwrightAvailable = false;
}

function skipForMissingBrowser(t, results) {
  const text = results.join("\n");
  if (
    /requires the "playwright" package/i.test(text) ||
    /executable doesn'?t exist/i.test(text) ||
    /please run the following command/i.test(text)
  ) {
    t.skip("Playwright runtime or browser binary is not available in this environment");
    return true;
  }
  return false;
}

before(async () => {
  if (!playwrightAvailable) return;

  server = http.createServer((req, res) => {
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser E2E</title>
  </head>
  <body>
    <h1 id="status">ready</h1>
    <input id="q" name="q" />
    <button id="go" type="button">Go</button>
    <script>
      const input = document.getElementById("q");
      const status = document.getElementById("status");
      input.addEventListener("input", () => {
        document.title = "Typed:" + input.value;
        status.textContent = input.value || "ready";
      });
      document.getElementById("go").addEventListener("click", () => {
        document.title = "Clicked";
        status.textContent = "clicked";
      });
    </script>
  </body>
</html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await closeBrowser();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

afterEach(async () => {
  if (previousDisableAutoharness === undefined) {
    delete process.env.CREWSWARM_DISABLE_AUTOHARNESS;
  } else {
    process.env.CREWSWARM_DISABLE_AUTOHARNESS = previousDisableAutoharness;
  }
  await closeBrowser();
});

describe("@@BROWSER live integration", { timeout: 120000 }, () => {
  test("navigates, screenshots, types, and clicks against a local page", async (t) => {
    previousDisableAutoharness = process.env.CREWSWARM_DISABLE_AUTOHARNESS;
    process.env.CREWSWARM_DISABLE_AUTOHARNESS = "1";
    if (!playwrightAvailable) {
      t.skip("Playwright package is not installed in this environment");
      return;
    }

    const navigateResults = await executeToolCalls(
      `@@BROWSER navigate ${baseUrl}`,
      "crew-coder-back",
      { projectId: "browser-e2e" }
    );
    if (skipForMissingBrowser(t, navigateResults)) return;
    assert.match(navigateResults.join("\n"), /\[tool:browser\] ✅ navigate/);
    assert.match(navigateResults.join("\n"), /title="Browser E2E"/);

    const screenshotResults = await executeToolCalls(
      `@@BROWSER screenshot ${baseUrl}`,
      "crew-coder-back",
      { projectId: "browser-e2e" }
    );
    assert.match(screenshotResults.join("\n"), /\[tool:browser\] ✅ screenshot/);
    const screenshotMatch = screenshotResults.join("\n").match(/file=([^\s]+)/);
    assert.ok(screenshotMatch, "expected screenshot file path");
    assert.equal(fs.existsSync(screenshotMatch[1]), true);

    const typeResults = await executeToolCalls(
      `@@BROWSER type ${baseUrl} #q "crewswarm E2E"`,
      "crew-coder-back",
      { projectId: "browser-e2e" }
    );
    assert.match(typeResults.join("\n"), /\[tool:browser\] ✅ type/);
    assert.match(typeResults.join("\n"), /text="crewswarm E2E"/);

    const clickResults = await executeToolCalls(
      `@@BROWSER click ${baseUrl} #go`,
      "crew-coder-back",
      { projectId: "browser-e2e" }
    );
    assert.match(clickResults.join("\n"), /\[tool:browser\] ✅ click/);
    assert.match(clickResults.join("\n"), /title="Clicked"/);
  });
});
