import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function read(relativePath) {
  return fs.readFile(path.join(rootDir, relativePath), "utf8");
}

function test(name, fn) {
  return { name, fn };
}

async function runTests(label, tests) {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.fn();
      passed += 1;
      console.log(`PASS ${label}: ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${label}: ${current.name}`);
      throw error;
    }
  }
  console.log(`${label} suite passed (${passed}/${tests.length})`);
}

export async function runAccessibilityTests() {
  const [html, appSource] = await Promise.all([
    read("index.html"),
    read("src/main.js"),
  ]);

  const tests = [
    test("document declares language metadata", () => {
      assert.match(html, /<html[^>]*lang="en"/i);
      assert.match(html, /<meta name="viewport" content="width=device-width,\s*initial-scale=1\.0"/i);
    }),
    test("primary application shell is present", () => {
      assert.match(html, /<div[^>]+id="app"/i);
    }),
    test("icon-only controls expose accessible names", () => {
      assert.match(html, /aria-label="Toggle color theme"/);
      assert.match(html, /aria-label="Open settings panel"/);
      assert.match(html, /aria-label="Toggle keyboard shortcuts guide"/);
      assert.match(html, /aria-label="Interactive terminal"/);
    }),
    test("overlay panels are labelled by their titles", () => {
      assert.match(html, /id="settings-panel"[\s\S]*aria-labelledby="settings-panel-title"/);
      assert.match(html, /id="shortcuts-panel"[\s\S]*aria-labelledby="shortcuts-panel-title"/);
      assert.match(html, /id="diff-preview-overlay"[\s\S]*aria-labelledby="diff-preview-title"/);
    }),
    test("terminal panel starts hidden for assistive tech", () => {
      assert.match(html, /id="bottom-terminal-panel"[^>]*aria-hidden="true"/);
    }),
    test("keyboard escape handling closes open overlays", () => {
      assert.match(html, /if \(event\.key === "Escape" && settingsPanel\?\.classList\.contains\("visible"\)\)/);
      assert.match(html, /setSettingsPanelOpen\(false\)/);
      assert.match(html, /setShortcutsPanelOpen\(false\)/);
    }),
  ];

  await runTests("accessibility", tests);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runAccessibilityTests().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
