import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { checkServiceUp } from "../helpers/http.mjs";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:4319";
const CREW_LEAD_URL = process.env.CREW_LEAD_URL || "http://127.0.0.1:5010";

let browser = null;
let page = null;
let servicesUp = false;

function skipIfDown(t) {
  if (!servicesUp) {
    t.skip("Requires dashboard :4319 and crew-lead :5010");
    return true;
  }
  return false;
}

async function gotoDashboard(hash = "#chat") {
  await page.goto(`${DASHBOARD_URL}/${hash}`, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  // Wait for chat input to be ready (SSE connections prevent networkidle2)
  const inputId = hash === "#swarm-chat" ? "swarmChatInput" : "chatInput";
  await page.waitForSelector(`#${inputId}`, { timeout: 10000 });
}

async function clearAndType(selector, text) {
  await page.focus(selector);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  await page.type(selector, text, { delay: 20 });
}

async function waitForHash(prefix, timeout = 4000) {
  await page.waitForFunction(
    (expectedPrefix) => window.location.hash.startsWith(expectedPrefix),
    { timeout },
    prefix,
  );
}

describe("Dashboard chat tabs", { timeout: 60000 }, () => {
  before(async () => {
    const [dashUp, crewLeadUp] = await Promise.all([
      checkServiceUp(`${DASHBOARD_URL}/api/env`),
      checkServiceUp(`${CREW_LEAD_URL}/health`),
    ]);
    servicesUp = dashUp && crewLeadUp;
    if (!servicesUp) return;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1440, height: 960 },
    });
    page = await browser.newPage();
    page.setDefaultTimeout(15000);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test("Chat click-send stays on chat and appends the user message", async (t) => {
    if (skipIfDown(t)) return;

    await gotoDashboard("#chat");
    await waitForHash("#chat");
    const message = `chat click ${Date.now()}`;

    await clearAndType("#chatInput", message);
    await page.click("#chatSendBtn");

    await waitForHash("#chat");
    await page.waitForFunction(
      (expected) => {
        const input = document.getElementById("chatInput");
        const chat = document.getElementById("chatMessages");
        return input && input.value === "" && chat && chat.textContent.includes(expected);
      },
      { timeout: 8000 },
      message,
    );
  });

  test("Chat Enter-send stays on chat and appends the user message", async (t) => {
    if (skipIfDown(t)) return;

    await gotoDashboard("#chat");
    await waitForHash("#chat");
    const message = `chat enter ${Date.now()}`;

    await clearAndType("#chatInput", message);
    await page.keyboard.press("Enter");

    await waitForHash("#chat");
    await page.waitForFunction(
      (expected) => {
        const input = document.getElementById("chatInput");
        const chat = document.getElementById("chatMessages");
        return input && input.value === "" && chat && chat.textContent.includes(expected);
      },
      { timeout: 8000 },
      message,
    );
  });

  test("Swarm click-send stays on swarm-chat", async (t) => {
    if (skipIfDown(t)) return;

    await gotoDashboard("#swarm-chat");
    await waitForHash("#swarm-chat");
    const message = `swarm click ${Date.now()}`;

    await clearAndType("#swarmChatInput", message);
    await page.click("#swarmChatSend");

    await waitForHash("#swarm-chat");
    await page.waitForFunction(
      () => {
        const input = document.getElementById("swarmChatInput");
        return input && input.value === "";
      },
      { timeout: 8000 },
    );
  });

  test("Swarm Enter-send stays on swarm-chat", async (t) => {
    if (skipIfDown(t)) return;

    await gotoDashboard("#swarm-chat");
    await waitForHash("#swarm-chat");
    const message = `swarm enter ${Date.now()}`;

    await clearAndType("#swarmChatInput", message);
    await page.keyboard.press("Enter");

    await waitForHash("#swarm-chat");
    await page.waitForFunction(
      () => {
        const input = document.getElementById("swarmChatInput");
        return input && input.value === "";
      },
      { timeout: 8000 },
    );
  });
});
