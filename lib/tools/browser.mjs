import fs from "fs";
import os from "os";
import path from "path";

let _playwrightOverride = null;
let _browserPromise = null;

function browserArtifactsDir() {
  const dir = path.join(os.tmpdir(), "crewswarm-browser");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function artifactPath(label) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return path.join(browserArtifactsDir(), `${safeStamp()}-${label}-${suffix}.png`);
}

async function loadPlaywright() {
  if (_playwrightOverride) return _playwrightOverride;
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(
      `Browser automation requires the "playwright" package in the crewswarm runtime (${error.message})`
    );
  }
}

async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = loadPlaywright().then(({ chromium }) =>
      chromium.launch({ headless: true })
    );
  }
  return _browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.setDefaultNavigationTimeout?.(15000);
    page.setDefaultTimeout?.(5000);
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function captureScreenshot(page, label, options = {}) {
  const filePath = artifactPath(label);
  await page.screenshot({ path: filePath, fullPage: Boolean(options.fullPage) });
  return filePath;
}

function summarizeError(action, error) {
  return new Error(`${action} failed: ${error.message}`);
}

export async function browserNavigate(url) {
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      const title = await page.title();
      const screenshotPath = await captureScreenshot(page, "navigate");
      return { action: "navigate", url, title, screenshotPath };
    });
  } catch (error) {
    throw summarizeError("navigate", error);
  }
}

export async function browserScreenshot(url) {
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      const title = await page.title();
      const screenshotPath = await captureScreenshot(page, "screenshot", { fullPage: true });
      return { action: "screenshot", url, title, screenshotPath };
    });
  } catch (error) {
    throw summarizeError("screenshot", error);
  }
}

export async function browserClick(url, selector) {
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.click(selector);
      await page.waitForLoadState?.("networkidle").catch(() => {});
      const title = await page.title();
      const screenshotPath = await captureScreenshot(page, "click");
      return { action: "click", url, selector, title, screenshotPath };
    });
  } catch (error) {
    throw summarizeError(`click ${selector}`, error);
  }
}

export async function browserType(url, selector, text) {
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.fill(selector, text);
      const title = await page.title();
      const screenshotPath = await captureScreenshot(page, "type");
      return { action: "type", url, selector, text, title, screenshotPath };
    });
  } catch (error) {
    throw summarizeError(`type ${selector}`, error);
  }
}

export async function closeBrowser() {
  if (!_browserPromise) return;
  try {
    const browser = await _browserPromise;
    await browser.close();
  } finally {
    _browserPromise = null;
  }
}

export function __setPlaywrightForTests(playwright) {
  _playwrightOverride = playwright;
  _browserPromise = null;
}
