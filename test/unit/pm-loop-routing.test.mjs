/**
 * Unit tests for pm-loop agent routing and roadmap item parsing logic.
 * We extract the pure functions inline (no top-level side effects in pm-loop.mjs
 * so we cannot import it directly in test context — we duplicate the logic under test).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── routeAgent keyword fallback (pure, extracted from pm-loop.mjs) ────────
const CODER_AGENT = "crew-coder";
function keywordRoute(itemText, nonDoers = new Set()) {
  const t = itemText.toLowerCase();
  let agent;
  if (/\bgit\b|github|commit|push|pull.request|branch|deploy/.test(t)) agent = "crew-github";
  else if (/\bapi\b|server|node|express|script|endpoint|json|database|backend|mjs|\.js\b/.test(t)) agent = "crew-coder-back";
  else if (/html|css|style|section|design|layout|animation|nav|hero|frontend|ui\b|ux\b|responsive/.test(t)) agent = "crew-coder-front";
  else agent = CODER_AGENT;
  if (nonDoers.has(agent)) agent = CODER_AGENT;
  return agent;
}

// ── markItem marker replacement (pure, extracted from pm-loop.mjs) ─────────
function applyMarkDone(line, agent = null) {
  line = line.replace(/\[[ !]\]/, "[x]");
  if (agent) line += ` (${agent})`;
  return line;
}
function applyMarkFailed(line) {
  return line.replace(/\[ \]/, "[!]");
}

// ── Roadmap item picker (pure, extracted from pm-loop.mjs) ─────────────────
function pickNextItem(roadmapContent) {
  const lines = roadmapContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- \[ \]/.test(line)) {
      return { lineIdx: i, text: line.replace(/^- \[ \]\s*/, "").trim() };
    }
  }
  return null;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("pm-loop — keyword agent routing", () => {
  it("routes git/github tasks to crew-github", () => {
    assert.equal(keywordRoute("commit the changes to github"), "crew-github");
    assert.equal(keywordRoute("create a pull request on the repo"), "crew-github");
    assert.equal(keywordRoute("deploy the app to production"), "crew-github");
  });

  it("routes backend/API tasks to crew-coder-back", () => {
    assert.equal(keywordRoute("add a REST API endpoint for user login"), "crew-coder-back");
    assert.equal(keywordRoute("write a Node.js server script"), "crew-coder-back");
    assert.equal(keywordRoute("update the database schema"), "crew-coder-back");
  });

  it("routes frontend/CSS tasks to crew-coder-front", () => {
    assert.equal(keywordRoute("add a hero section with CSS animation"), "crew-coder-front");
    assert.equal(keywordRoute("make the nav responsive for mobile"), "crew-coder-front");
    assert.equal(keywordRoute("update the UI layout for the dashboard"), "crew-coder-front");
  });

  it("routes unrecognized tasks to default crew-coder", () => {
    assert.equal(keywordRoute("improve error handling in the auth flow"), CODER_AGENT);
    assert.equal(keywordRoute("write tests for the billing module"), CODER_AGENT);
  });

  it("falls back to crew-coder when preferred agent is in nonDoers set", () => {
    const nonDoers = new Set(["crew-github"]);
    assert.equal(keywordRoute("commit and push to git", nonDoers), CODER_AGENT);
  });

  it("does not fall back when nonDoers is empty", () => {
    assert.equal(keywordRoute("push to github", new Set()), "crew-github");
  });
});

describe("pm-loop — markItem marker logic", () => {
  it("replaces [ ] with [x] on done", () => {
    const result = applyMarkDone("- [ ] Build the login page");
    assert.ok(result.includes("[x]"), `expected [x] in: ${result}`);
  });

  it("replaces [!] with [x] on done (retry mark)", () => {
    const result = applyMarkDone("- [!] Build the login page");
    assert.ok(result.includes("[x]"), `expected [x] in: ${result}`);
  });

  it("appends agent name on done when agent provided", () => {
    const result = applyMarkDone("- [ ] Build the login page", "crew-coder-front");
    assert.ok(result.includes("(crew-coder-front)"), `expected agent in: ${result}`);
  });

  it("does not append agent when not provided", () => {
    const result = applyMarkDone("- [ ] Build the login page");
    assert.ok(!result.includes("crew-"), `unexpected agent in: ${result}`);
  });

  it("replaces [ ] with [!] on failure", () => {
    const result = applyMarkFailed("- [ ] Build the login page");
    assert.ok(result.includes("[!]"), `expected [!] in: ${result}`);
  });

  it("does not double-mark [!] if already failed", () => {
    const result = applyMarkFailed("- [!] Build the login page");
    const count = (result.match(/\[!\]/g) || []).length;
    assert.equal(count, 1, "should have exactly one [!]");
  });
});

describe("pm-loop — pickNextItem from roadmap content", () => {
  it("returns first unchecked item", () => {
    const md = `# Roadmap\n\n- [x] Done task\n- [ ] Next task\n- [ ] Later task\n`;
    const item = pickNextItem(md);
    assert.ok(item, "expected an item");
    assert.equal(item.text, "Next task");
    assert.equal(item.lineIdx, 3);
  });

  it("returns null when all items are done", () => {
    const md = `# Roadmap\n\n- [x] Task one done\n- [x] Task two done\n`;
    assert.equal(pickNextItem(md), null);
  });

  it("returns null for empty roadmap", () => {
    assert.equal(pickNextItem("# Roadmap\n\nNo items here."), null);
  });

  it("skips [!] failed items and picks plain [ ] items", () => {
    const md = `# Roadmap\n\n- [!] Failed item\n- [ ] Good item\n`;
    const item = pickNextItem(md);
    assert.ok(item, "expected an item");
    assert.equal(item.text, "Good item");
  });

  it("extracts item text without the markdown bullet prefix", () => {
    const md = `- [ ]   Build the hero section with animations\n`;
    const item = pickNextItem(md);
    assert.equal(item.text, "Build the hero section with animations");
  });

  it("handles items with trailing whitespace", () => {
    const md = `- [ ] Add footer links   \n`;
    const item = pickNextItem(md);
    assert.equal(item.text, "Add footer links");
  });
});
