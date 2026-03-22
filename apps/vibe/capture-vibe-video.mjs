#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "website", "vibe-assets");
const VIDEO_NAME = "vibe-demo.webm";
const OUTPUT_PATH = join(OUT, VIDEO_NAME);

const DASHBOARD_URL = process.env.CREWSWARM_DASHBOARD_URL || "http://127.0.0.1:4319";
const VIBE_URL = process.env.CREWSWARM_VIBE_URL || "http://127.0.0.1:3333";

const VIEWPORT = { width: 1440, height: 900 };
const SPLIT_SCENE_MS = 18_000;
const VIBE_SCENE_MS = 38_000;
const DASHBOARD_SCENE_MS = 34_000;

mkdirSync(OUT, { recursive: true });

function isUrlUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode) && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForUrl(url, label, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUrlUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function buildSplitSceneHtml() {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>CrewSwarm Demo Scene</title>
      <style>
        :root {
          color-scheme: dark;
          --bg: #060a10;
          --panel: #0c121b;
          --text: #f4f7fb;
          --muted: #9cb0c7;
          --accent: #35d6c2;
          --border: rgba(255, 255, 255, 0.08);
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background:
            radial-gradient(circle at 20% 0%, rgba(53, 214, 194, 0.14), transparent 32%),
            radial-gradient(circle at 80% 10%, rgba(73, 124, 255, 0.14), transparent 28%),
            var(--bg);
          color: var(--text);
        }
        .wrap {
          display: grid;
          grid-template-rows: auto 1fr;
          height: 100vh;
          padding: 18px 18px 14px;
          gap: 14px;
        }
        .header {
          display: grid;
          grid-template-columns: 1.15fr 1fr;
          gap: 16px;
          align-items: stretch;
        }
        .hero {
          background: rgba(10, 16, 24, 0.82);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 20px 22px;
          backdrop-filter: blur(10px);
        }
        .hero h1 {
          margin: 0 0 8px;
          font-size: 28px;
          line-height: 1.1;
        }
        .hero p {
          margin: 0;
          color: var(--muted);
          font-size: 15px;
          line-height: 1.45;
        }
        .command {
          background: rgba(7, 12, 18, 0.95);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 18px 20px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 10px;
        }
        .command .eyebrow {
          color: var(--accent);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }
        .command code {
          display: block;
          font-family: "SF Mono", "Fira Code", monospace;
          font-size: 16px;
          line-height: 1.4;
          color: #ecfeff;
          white-space: pre-wrap;
        }
        .panes {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
          min-height: 0;
        }
        .pane {
          min-height: 0;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 18px;
          overflow: hidden;
          display: grid;
          grid-template-rows: auto 1fr;
        }
        .pane-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px;
          font-size: 12px;
          color: var(--muted);
          background: rgba(255, 255, 255, 0.02);
          border-bottom: 1px solid var(--border);
        }
        .pane-bar strong {
          color: var(--text);
          font-size: 13px;
        }
        iframe {
          width: 100%;
          height: 100%;
          border: 0;
          background: #0b1016;
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="header">
          <section class="hero">
            <h1>CrewSwarm in one fast pass</h1>
            <p>
              Launch the stack, code in Vibe, and keep the runtime visible in the dashboard.
              This cut is recorded from the live local surfaces, not mocked marketing panels.
            </p>
          </section>
          <section class="command">
            <div class="eyebrow">Install</div>
            <code>bash &lt;(curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/install.sh)</code>
          </section>
        </div>
        <section class="panes">
          <div class="pane">
            <div class="pane-bar"><strong>Dashboard</strong><span>${DASHBOARD_URL}</span></div>
            <iframe id="dash-frame" src="${DASHBOARD_URL}"></iframe>
          </div>
          <div class="pane">
            <div class="pane-bar"><strong>Vibe</strong><span>${VIBE_URL}</span></div>
            <iframe id="vibe-frame" src="${VIBE_URL}"></iframe>
          </div>
        </section>
      </div>
    </body>
  </html>`;
}

async function record() {
  await waitForUrl(DASHBOARD_URL, "dashboard");
  await waitForUrl(VIBE_URL, "vibe");

  rmSync(OUTPUT_PATH, { force: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: {
      dir: OUT,
      size: VIEWPORT,
    },
    viewport: VIEWPORT,
    colorScheme: "dark",
  });

  const page = await context.newPage();

  try {
    console.log("🎬 Scene 1/3: split dashboard + vibe");
    await page.setContent(buildSplitSceneHtml(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SPLIT_SCENE_MS);

    console.log("🎬 Scene 2/3: Vibe");
    await page.goto(VIBE_URL, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await page.selectOption("#chat-mode-selector", "cli:codex").catch(() => {});
    await page.waitForTimeout(1_000);
    await page.click("#toggle-bottom-terminal").catch(() => {});
    await page.waitForTimeout(3_000);
    await page.click("#preview-diff-trigger").catch(() => {});
    await page.waitForTimeout(5_000);
    await page.click(".diff-preview-close").catch(() => {});
    await page.waitForTimeout(1_000);
    await page.fill("#chat-input", "Explain what this workspace is for in one short paragraph.").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(VIBE_SCENE_MS - 12_000);

    console.log("🎬 Scene 3/3: dashboard");
    await page.goto(DASHBOARD_URL, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await page.click("#navServices").catch(() => {});
    await page.waitForTimeout(10_000);
    await page.click("#navAgents").catch(() => {});
    await page.waitForTimeout(10_000);
    await page.click("#navBuild").catch(() => {});
    await page.waitForTimeout(DASHBOARD_SCENE_MS - 22_000);
  } finally {
    const video = page.video();
    if (video) {
      await video.saveAs(OUTPUT_PATH);
    }
    await page.close();
    await context.close();
    await browser.close();
  }
}

record()
  .then(() => {
    console.log(`✨ Saved 90-second demo to ${OUTPUT_PATH}`);
  })
  .catch((error) => {
    console.error("❌ Demo capture failed:", error.message);
    process.exit(1);
  });
