#!/usr/bin/env node
/**
 * CrewSwarm Demo Video — Real UI Recording
 *
 * Records a ~45s demo: Vibe IDE chat + Dashboard tour
 * Outputs mp4 + webm via ffmpeg.
 *
 * Requires: dashboard on :4319, vibe on :3333, playwright, ffmpeg
 */
import { chromium } from "playwright";
import { mkdirSync, rmSync, existsSync, statSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "website", "vibe-assets");
const FINAL_MP4 = join(OUT, "vibe-demo.mp4");
const FINAL_WEBM = join(OUT, "vibe-demo.webm");

const DASHBOARD_URL = "http://127.0.0.1:4319";
const VIBE_URL = "http://127.0.0.1:3333";
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });

async function record() {
  console.log("⏳ Checking services...");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: { dir: OUT, size: VIEWPORT },
    viewport: VIEWPORT,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  try {
    // ─── SCENE 1: Vibe IDE ──────────────────────────
    console.log("🎬 Scene 1: Vibe IDE");
    await page.goto(VIBE_URL, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    // Select Vibe Workspace project
    console.log("   → Selecting project...");
    try {
      const selects = page.locator("select");
      const count = await selects.count();
      if (count > 0) {
        await selects.first().selectOption({ label: "Vibe Workspace" });
        await page.waitForTimeout(2_000);
      }
    } catch (e) { console.log("   (skip project select:", e.message, ")"); }

    // Click a file in the explorer
    console.log("   → Opening file...");
    try {
      // Click on server.mjs in the file tree
      await page.locator("text=server.mjs").first().click({ timeout: 3000 });
      await page.waitForTimeout(3_000);
    } catch { console.log("   (no file to click)"); }

    // Type a message in chat
    console.log("   → Typing in chat...");
    try {
      const textarea = page.locator("textarea").first();
      await textarea.click();
      const msg = "Add a GET /health endpoint that returns { status: \"ok\" }";
      for (const ch of msg) {
        await page.keyboard.type(ch, { delay: 30 });
      }
      await page.waitForTimeout(500);
      console.log("   → Sending message...");
      await page.keyboard.press("Enter");
      // Wait for agent response to stream
      console.log("   → Waiting for response (20s)...");
      await page.waitForTimeout(20_000);
    } catch (e) { console.log("   (chat error:", e.message, ")"); }

    // Show terminal
    console.log("   → Toggling terminal...");
    try {
      await page.locator("button", { hasText: "Terminal" }).click({ timeout: 2000 });
      await page.waitForTimeout(2_000);
    } catch { console.log("   (no terminal button)"); }

    // Hold for a beat
    await page.waitForTimeout(2_000);

    // ─── SCENE 2: Dashboard ─────────────────────────
    console.log("🎬 Scene 2: Dashboard");
    await page.goto(DASHBOARD_URL, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(4_000);

    // Click through sidebar tabs
    const tabs = ["Sessions", "Agents", "Models", "Engines", "Swarm"];
    for (const name of tabs) {
      try {
        console.log(`   → ${name}...`);
        await page.locator(`text="${name}"`).first().click({ timeout: 2000 });
        await page.waitForTimeout(3_500);
      } catch { console.log(`   (skip ${name})`); }
    }

    // End on Chat
    try {
      await page.locator('text="Chat"').first().click({ timeout: 2000 });
      await page.waitForTimeout(3_000);
    } catch {}

  } finally {
    console.log("💾 Saving...");
    await page.close();
    await context.close();
    await browser.close();
  }

  // Find the recorded webm (Playwright names it randomly)
  const webms = readdirSync(OUT).filter(f => f.endsWith(".webm") && f !== "vibe-demo.webm");
  if (webms.length === 0) {
    console.error("❌ No recording found");
    process.exit(1);
  }
  // Use the newest one
  webms.sort((a, b) => statSync(join(OUT, b)).mtimeMs - statSync(join(OUT, a)).mtimeMs);
  const rawPath = join(OUT, webms[0]);
  console.log(`📼 Raw recording: ${rawPath}`);

  // Convert to mp4
  console.log("🎞️  Converting to mp4...");
  rmSync(FINAL_MP4, { force: true });
  execSync(
    `ffmpeg -y -i "${rawPath}" -vcodec libx264 -crf 23 -preset slow -vf "scale=1440:900:flags=lanczos" -movflags +faststart -an "${FINAL_MP4}"`,
    { stdio: "inherit" }
  );

  // Convert to webm (for web embed)
  console.log("🎞️  Converting to webm...");
  rmSync(FINAL_WEBM, { force: true });
  execSync(
    `ffmpeg -y -i "${rawPath}" -c:v libvpx-vp9 -crf 30 -b:v 0 -vf "scale=1440:900:flags=lanczos" -an "${FINAL_WEBM}"`,
    { stdio: "inherit" }
  );

  // Clean up raw
  rmSync(rawPath, { force: true });

  const mp4KB = Math.round(statSync(FINAL_MP4).size / 1024);
  const webmKB = Math.round(statSync(FINAL_WEBM).size / 1024);
  console.log(`\n✨ Done:`);
  console.log(`   mp4:  ${FINAL_MP4} (${mp4KB} KB)`);
  console.log(`   webm: ${FINAL_WEBM} (${webmKB} KB)`);
}

record()
  .then(() => console.log("\n🎬 Demo capture complete!"))
  .catch((err) => {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  });
