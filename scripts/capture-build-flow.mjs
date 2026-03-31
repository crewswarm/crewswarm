#!/usr/bin/env node
/**
 * capture-build-flow.mjs — Puppeteer script that captures dashboard
 * screenshots during a build flow for documentation / demo purposes.
 *
 * Usage:  node scripts/capture-build-flow.mjs
 * Requires: dashboard running at http://127.0.0.1:4319
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "website/screenshots/flow");
const BASE_URL = "http://127.0.0.1:4319";

const STEPS = [
  { name: "step1-build-tab",    hash: "build",  waitMs: 2000  },
  { name: "step2-requirement",  action: "type"                 },
  { name: "step3-plan",         action: "plan",  waitMs: 20000 },
  { name: "step4-chat",         hash: "chat",   waitMs: 3000  },
  { name: "step5-agents",       hash: "swarm",  waitMs: 2000  },
  { name: "step6-rt-messages",  hash: "rt",     waitMs: 2000  },
];

async function screenshot(page, name) {
  const path = resolve(OUT_DIR, `${name}.webp`);
  await page.screenshot({ path, type: "webp", quality: 85 });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox"],
    defaultViewport: { width: 1440, height: 960 },
  });

  const page = await browser.newPage();

  // Step 1 — navigate to #build
  await page.goto(`${BASE_URL}/#build`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await screenshot(page, "step1-build-tab");

  // Step 2 — type requirement
  const REQUIREMENT = "Create a simple hello world HTML page";
  // Try a few selectors for the requirement input
  const textareaSelector = await page
    .waitForSelector("textarea, #requirement, .requirement-input", {
      timeout: 5000,
    })
    .catch(() => null);

  if (textareaSelector) {
    await textareaSelector.click();
    await textareaSelector.type(REQUIREMENT, { delay: 30 });
  }
  await screenshot(page, "step2-requirement");

  // Step 3 — click Plan and wait for result
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const planBtn = buttons.find((b) => /plan/i.test(b.textContent));
    if (planBtn) planBtn.click();
  });
  await sleep(20000);
  await screenshot(page, "step3-plan");

  // Step 4 — Chat tab
  await page.goto(`${BASE_URL}/#chat`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  await screenshot(page, "step4-chat");

  // Step 5 — Swarm / agents tab
  await page.goto(`${BASE_URL}/#swarm`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await screenshot(page, "step5-agents");

  // Step 6 — RT messages tab
  await page.goto(`${BASE_URL}/#rt`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await screenshot(page, "step6-rt-messages");

  await browser.close();

  const files = [
    "step1-build-tab.webp",
    "step2-requirement.webp",
    "step3-plan.webp",
    "step4-chat.webp",
    "step5-agents.webp",
    "step6-rt-messages.webp",
  ];

  console.log(`\nCaptured ${files.length} build flow frames:`);
  for (const f of files) {
    console.log(`  website/screenshots/flow/${f}`);
  }
  console.log(
    `\nTo create animated webp: convert -delay 200 website/screenshots/flow/*.webp website/screenshots/build-flow.webp`,
  );
}

main().catch((err) => {
  console.error("Build flow capture failed:", err.message);
  process.exit(1);
});
