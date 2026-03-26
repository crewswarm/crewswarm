#!/usr/bin/env node
/**
 * CrewSwarm Full Demo — Screenshot Capture + Slideshow Video
 *
 * Takes screenshots of all key features across Vibe + Dashboard,
 * then stitches them into a crossfade slideshow video.
 *
 * Requires: vibe on :3333, dashboard on :4319, playwright, ffmpeg
 */
import { chromium } from "playwright";
import { mkdirSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "website", "vibe-assets");
const FINAL_MP4 = join(OUT, "vibe-demo.mp4");
const FINAL_WEBM = join(OUT, "vibe-demo.webm");

const VIBE_URL = "http://127.0.0.1:3333";
const DASHBOARD_URL = "http://127.0.0.1:4319";
const VIEWPORT = { width: 1440, height: 900 };

// Slide duration in seconds for the final video
const SLIDE_DURATION = 3.5;
const CROSSFADE_DURATION = 0.8;

mkdirSync(OUT, { recursive: true });

// Clean old slides
for (const f of readdirSync(OUT)) {
  if (f.startsWith("slide-") && f.endsWith(".png")) {
    rmSync(join(OUT, f), { force: true });
  }
}

let slideNum = 0;
function slidePath() {
  slideNum++;
  return join(OUT, `slide-${String(slideNum).padStart(2, "0")}.png`);
}

async function capture() {
  console.log("Checking services...");

  const browser = await chromium.launch({ headless: true });

  // ─── VIBE SCREENSHOTS ─────────────────────────────────
  console.log("\n=== VIBE IDE ===");
  const vibeCtx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
  });
  const vibe = await vibeCtx.newPage();

  // Slide 1: Vibe IDE — editor view
  console.log("  [1] Vibe IDE — editor overview");
  await vibe.goto(VIBE_URL, { waitUntil: "load", timeout: 30_000 });
  await vibe.waitForTimeout(3_000);
  // Try to open a file
  try {
    await vibe.locator("text=server.mjs").first().click({ timeout: 3000 });
    await vibe.waitForTimeout(2_000);
  } catch { console.log("      (no file to open)"); }
  await vibe.screenshot({ path: slidePath() });

  // Slide 2: Vibe — Claude Code selected
  console.log("  [2] Vibe — Claude Code engine");
  try {
    const sel = vibe.locator("#chat-mode-selector");
    await sel.selectOption("cli:claude");
    await vibe.waitForTimeout(1_000);
  } catch { console.log("      (skip engine select)"); }
  await vibe.screenshot({ path: slidePath() });

  // Slide 3: Vibe — Cursor CLI selected
  console.log("  [3] Vibe — Cursor CLI engine");
  try {
    const sel = vibe.locator("#chat-mode-selector");
    await sel.selectOption("cli:cursor");
    await vibe.waitForTimeout(1_000);
  } catch { console.log("      (skip engine select)"); }
  await vibe.screenshot({ path: slidePath() });

  // Slide 4: Vibe — Gemini CLI selected
  console.log("  [4] Vibe — Gemini CLI engine");
  try {
    const sel = vibe.locator("#chat-mode-selector");
    await sel.selectOption("cli:gemini");
    await vibe.waitForTimeout(1_000);
  } catch { console.log("      (skip engine select)"); }
  await vibe.screenshot({ path: slidePath() });

  // Slide 5: Vibe — typing a prompt in the chat input
  console.log("  [5] Vibe — typing prompt");
  try {
    const sel = vibe.locator("#chat-mode-selector");
    await sel.selectOption("cli:claude");
    await vibe.waitForTimeout(500);
    const chatInput = vibe.locator("#chat-input");
    await chatInput.click({ timeout: 5000 });
    const msg = "Add session resume for all CLI engines with --resume flag";
    await chatInput.fill(msg);
    await vibe.waitForTimeout(500);
  } catch (e) { console.log("      (skip prompt:", e.message, ")"); }
  await vibe.screenshot({ path: slidePath() });

  // Slide 6: Vibe — send and capture response
  console.log("  [6] Vibe — agent working");
  try {
    await vibe.keyboard.press("Enter");
    // Wait for response to stream
    await vibe.waitForTimeout(18_000);
  } catch { console.log("      (skip response)"); }
  await vibe.screenshot({ path: slidePath() });

  // Slide 7: Vibe — terminal view
  console.log("  [7] Vibe — terminal");
  try {
    await vibe.locator("button", { hasText: "Terminal" }).click({ timeout: 2000 });
    await vibe.waitForTimeout(2_000);
  } catch { console.log("      (no terminal)"); }
  await vibe.screenshot({ path: slidePath() });

  await vibe.close();
  await vibeCtx.close();

  // ─── DASHBOARD SCREENSHOTS ────────────────────────────
  console.log("\n=== DASHBOARD ===");
  const dashCtx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
  });
  const dash = await dashCtx.newPage();

  await dash.goto(DASHBOARD_URL, { waitUntil: "load", timeout: 60_000 });
  await dash.waitForTimeout(4_000);

  // Slide 8: Dashboard — Chat view (default)
  console.log("  [8] Dashboard — Chat");
  await dash.screenshot({ path: slidePath() });

  // Dashboard tabs to cycle through
  const dashTabs = [
    { name: "Sessions", label: "9" },
    { name: "Agents", label: "10" },
    { name: "Engines", label: "11" },
    { name: "Models", label: "12" },
    { name: "Build", label: "13" },
    { name: "Swarm", label: "14" },
  ];

  for (const tab of dashTabs) {
    console.log(`  [${tab.label}] Dashboard — ${tab.name}`);
    try {
      await dash.locator(`text="${tab.name}"`).first().click({ timeout: 3000 });
      await dash.waitForTimeout(2_500);
      await dash.screenshot({ path: slidePath() });
    } catch {
      console.log(`      (skip ${tab.name})`);
    }
  }

  await dash.close();
  await dashCtx.close();
  await browser.close();

  console.log(`\n${slideNum} screenshots captured.`);
  return slideNum;
}

function buildVideo(totalSlides) {
  console.log("\n=== BUILDING VIDEO ===");

  // Build ffmpeg filter for crossfade slideshow
  // Each slide shows for SLIDE_DURATION, with CROSSFADE_DURATION transition
  const slides = [];
  for (let i = 1; i <= totalSlides; i++) {
    const p = join(OUT, `slide-${String(i).padStart(2, "0")}.png`);
    if (!existsSync(p)) continue;
    slides.push(p);
  }

  if (slides.length === 0) {
    console.error("No slides found!");
    process.exit(1);
  }

  // Simple approach: use concat demuxer with each image shown for SLIDE_DURATION
  // Then add crossfade in a second pass
  const totalDuration = slides.length * SLIDE_DURATION;
  console.log(`  ${slides.length} slides, ${SLIDE_DURATION}s each = ~${Math.round(totalDuration)}s video`);

  // Build input args and filter complex for crossfade
  const inputs = slides.map(s => `-loop 1 -t ${SLIDE_DURATION} -i "${s}"`).join(" ");

  let filterComplex = "";
  if (slides.length === 1) {
    filterComplex = `[0:v]scale=${VIEWPORT.width}:${VIEWPORT.height},format=yuv420p[outv]`;
  } else {
    // Chain crossfades: [0][1]xfade -> [v01], [v01][2]xfade -> [v012], etc.
    const cf = CROSSFADE_DURATION;
    let lastLabel = "0:v";
    for (let i = 1; i < slides.length; i++) {
      const offset = i * SLIDE_DURATION - i * cf;
      const outLabel = i === slides.length - 1 ? "outv" : `v${i}`;
      filterComplex += `[${lastLabel}][${i}:v]xfade=transition=fade:duration=${cf}:offset=${offset.toFixed(2)}[${outLabel}];\n`;
      lastLabel = outLabel;
    }
    // Remove trailing semicolon+newline if present
    filterComplex = filterComplex.replace(/;\n$/, "");
  }

  // Generate MP4
  console.log("  Converting to mp4...");
  rmSync(FINAL_MP4, { force: true });
  const mp4Cmd = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -movflags +faststart -an "${FINAL_MP4}"`;
  try {
    execSync(mp4Cmd, { stdio: "pipe", timeout: 120_000 });
  } catch (e) {
    console.error("  mp4 error:", e.stderr?.toString().slice(-500));
    // Fallback: simple concat without crossfade
    console.log("  Trying simple concat fallback...");
    const concatInputs = slides.map(s => `-loop 1 -t ${SLIDE_DURATION} -i "${s}"`).join(" ");
    const concatFilter = slides.map((_, i) => `[${i}:v]scale=${VIEWPORT.width}:${VIEWPORT.height},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`).join(";") +
      ";" + slides.map((_, i) => `[v${i}]`).join("") + `concat=n=${slides.length}:v=1:a=0[outv]`;
    execSync(`ffmpeg -y ${concatInputs} -filter_complex "${concatFilter}" -map "[outv]" -c:v libx264 -crf 23 -preset slow -movflags +faststart -an "${FINAL_MP4}"`,
      { stdio: "pipe", timeout: 120_000 });
  }

  // Generate WebM
  console.log("  Converting to webm...");
  rmSync(FINAL_WEBM, { force: true });
  execSync(
    `ffmpeg -y -i "${FINAL_MP4}" -c:v libvpx-vp9 -crf 30 -b:v 0 -an "${FINAL_WEBM}"`,
    { stdio: "pipe", timeout: 120_000 }
  );

  const mp4KB = Math.round(statSync(FINAL_MP4).size / 1024);
  const webmKB = Math.round(statSync(FINAL_WEBM).size / 1024);
  console.log(`\nDone:`);
  console.log(`  mp4:  ${FINAL_MP4} (${mp4KB} KB)`);
  console.log(`  webm: ${FINAL_WEBM} (${webmKB} KB)`);
}

capture()
  .then((total) => {
    buildVideo(total);
    console.log("\nDemo capture complete!");
  })
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
