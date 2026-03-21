import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function read(relativePath) {
  return fs.readFile(path.join(rootDir, relativePath), "utf8");
}

async function stat(relativePath) {
  return fs.stat(path.join(rootDir, relativePath));
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

export async function runPerformanceTests() {
  const [html, appSource, serverSource, viteConfig] = await Promise.all([
    read("index.html"),
    read("src/main.js"),
    read("server.mjs"),
    read("vite.config.js"),
  ]);
  const distAssets = await fs.readdir(path.join(rootDir, "dist", "assets"));
  const jsAssets = distAssets.filter((name) => name.endsWith(".js"));
  const cssAssets = distAssets.filter((name) => name.endsWith(".css"));
  const indexBundle = jsAssets.find((name) => /^index-.*\.js$/.test(name));
  const indexBundleStat = indexBundle ? await stat(path.join("dist", "assets", indexBundle)) : null;

  const tests = [
    test("build output includes JavaScript and CSS assets", () => {
      assert.ok(jsAssets.length > 0, "expected built JavaScript assets");
      assert.ok(cssAssets.length > 0, "expected built CSS assets");
    }),
    test("main bundle stays below a 3 MB guardrail", () => {
      assert.ok(indexBundleStat, "expected a built index bundle");
      assert.ok(indexBundleStat.size < 3 * 1024 * 1024, `bundle too large: ${indexBundleStat.size}`);
    }),
    test("index.html avoids external font and CDN preconnects", () => {
      assert.match(html, /System font stack only to avoid CORS/i);
      assert.doesNotMatch(html, /<link rel="preconnect"/i);
    }),
    test("Monaco is loaded lazily through dynamic imports", () => {
      assert.match(appSource, /async function loadMonaco\(/);
      assert.match(appSource, /import\("monaco-editor\/esm\/vs\/editor\/editor\.api"\)/);
    }),
    test("editor renders a lightweight placeholder before Monaco loads", () => {
      assert.match(appSource, /function renderEditorPlaceholder\(/);
      assert.match(appSource, /Editor loads on demand/);
    }),
    test("explorer hides heavy generated directories from scans", () => {
      assert.match(appSource, /relativePath\.startsWith\("dist\/"\)/);
      assert.match(appSource, /relativePath\.startsWith\("node_modules\/"\)/);
      assert.match(appSource, /relativePath\.startsWith\("output\/"\)/);
    }),
    test("static server serves immutable cache headers for hashed assets", () => {
      assert.match(serverSource, /return "public, max-age=31536000, immutable";/);
    }),
    test("static server can serve precompressed assets", () => {
      assert.match(serverSource, /if \(acceptEncoding\.includes\("br"\)\)/);
      assert.match(serverSource, /if \(acceptEncoding\.includes\("gzip"\)\)/);
    }),
    test("Vite build targets the dist assets directory explicitly", () => {
      assert.match(viteConfig, /outDir:\s*["']dist["']/);
      assert.match(viteConfig, /assetsDir:\s*["']assets["']/);
    }),
    test("workspace scans cap file enumeration to avoid runaway traversal", () => {
      assert.match(serverSource, /const MAX_FILES = 800;/);
      assert.match(serverSource, /if \(depth > 6 \|\| results\.length >= MAX_FILES\) return;/);
    }),
    test("workspace scans use a short-lived cache with targeted invalidation", () => {
      assert.match(serverSource, /const WORKSPACE_SCAN_CACHE_TTL_MS = Number\(process\.env\.STUDIO_SCAN_CACHE_TTL_MS \|\| 1_500\);/);
      assert.match(serverSource, /workspaceScanCache\.set\(resolvedScanDir,\s*\{/);
      assert.match(serverSource, /invalidateWorkspaceScanCache\(resolvedPath\);/);
    }),
    test("audit cache is tracked and invalidated alongside workspace scans", () => {
      assert.match(serverSource, /const auditFileCache = new Map\(\);/);
      assert.match(serverSource, /for \(const cache of \[workspaceScanCache, auditFileCache\]\)/);
    }),
    test("file tree refreshes are debounced during bursty CLI updates", () => {
      assert.match(appSource, /const FILE_TREE_REFRESH_DEBOUNCE_MS = 150;/);
      assert.match(appSource, /function scheduleFileTreeRefresh\(/);
      assert.match(appSource, /scheduleFileTreeRefresh\(\);/);
    }),
    test("terminal output is capped to avoid long-session DOM bloat", () => {
      assert.match(appSource, /const MAX_TERMINAL_ENTRIES = 250;/);
      assert.match(appSource, /while \(container\.children\.length > MAX_TERMINAL_ENTRIES\)/);
    }),
  ];

  await runTests("performance", tests);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runPerformanceTests().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
