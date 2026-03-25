import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { checkServiceUp } from "../helpers/http.mjs";

const DASHBOARD_URL = "http://127.0.0.1:4319";
const VIBE_URL = "http://127.0.0.1:3333";
const CREW_LEAD_URL = "http://127.0.0.1:5010";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser = null;
let servicesUp = false;

function skipIfDown(t) {
  if (!servicesUp) {
    t.skip("Requires dashboard :4319, vibe :3333, crew-lead :5010");
    return true;
  }
  return false;
}

async function newPage() {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  return page;
}

async function clearAndType(page, selector, text) {
  await page.focus(selector);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  await page.type(selector, text, { delay: 10 });
}

describe("Dashboard + Vibe dispatch surfaces", { timeout: 120000 }, () => {
  before(async () => {
    const [dashUp, vibeUp, leadUp] = await Promise.all([
      checkServiceUp(`${DASHBOARD_URL}/api/health`),
      checkServiceUp(`${VIBE_URL}/api/studio/projects`),
      checkServiceUp(`${CREW_LEAD_URL}/health`),
    ]);
    servicesUp = dashUp && vibeUp && leadUp;
    if (!servicesUp) return;

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1440, height: 960 },
    });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test("Dashboard chat dispatches via crew-lead and shows the reply", async (t) => {
    if (skipIfDown(t)) return;

    const page = await newPage();
    const token = `DASHBOARD_UI_E2E_${Date.now()}`;

    try {
      await page.goto(`${DASHBOARD_URL}/#chat`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForSelector("#chatInput");
      await page.waitForSelector('#chatProjectTabs [data-project-id="general"]');
      await page.click('#chatProjectTabs [data-project-id="general"]');

      await clearAndType(
        page,
        "#chatInput",
        `dispatch crew-seo to reply with exactly ${token}`,
      );
      await page.click("#chatSendBtn");

      await page.waitForFunction(
        (expected) => {
          const box = document.getElementById("chatMessages");
          return box && box.textContent.includes("crew-seo") && box.textContent.includes(expected);
        },
        { timeout: 45000 },
        token,
      );
    } finally {
      await page.close();
    }
  });

  test("Vibe chat dispatches via crew-lead and shows the reply", async (t) => {
    if (skipIfDown(t)) return;

    const page = await newPage();
    const token = `VIBE_UI_E2E_${Date.now()}`;

    try {
      await page.goto(VIBE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForSelector("#chat-input");
      await page.select("#chat-mode-selector", "crew-lead");
      await page.select("#projectSelector", "general");

      await clearAndType(
        page,
        "#chat-input",
        `dispatch crew-seo to reply with exactly ${token}`,
      );
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (expected) => {
          const box = document.getElementById("chat-messages");
          return box && box.textContent.includes("crew-seo") && box.textContent.includes(expected);
        },
        { timeout: 45000 },
        token,
      );
    } finally {
      await page.close();
    }
  });
});
