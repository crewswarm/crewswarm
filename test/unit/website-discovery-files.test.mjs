import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const WEBSITE_DIR = path.join(ROOT, "website");

const sitemap = fs.readFileSync(path.join(WEBSITE_DIR, "sitemap.xml"), "utf8");
const llms = fs.readFileSync(path.join(WEBSITE_DIR, "llms.txt"), "utf8");
const llmsFull = fs.readFileSync(path.join(WEBSITE_DIR, "llms-full.txt"), "utf8");

describe("website discovery files", () => {
  it("sitemap includes the PM loop walkthrough and engine comparison pages", () => {
    assert.match(sitemap, /https:\/\/crewswarm\.ai\/pm-loop-walkthrough\.html/);
    assert.match(sitemap, /https:\/\/crewswarm\.ai\/engine-comparison\.html/);
  });

  it("llms.txt includes the new public pages and search phrases", () => {
    assert.match(llms, /PM Loop Walkthrough: https:\/\/crewswarm\.ai\/pm-loop-walkthrough\.html/);
    assert.match(llms, /Engine Comparison: https:\/\/crewswarm\.ai\/engine-comparison\.html/);
    assert.match(llms, /Claude Code vs Codex vs Cursor vs Gemini vs OpenCode vs crew-cli/);
  });

  it("llms-full documents the new pages and their purpose", () => {
    assert.match(llmsFull, /## PM loop walkthrough page/);
    assert.match(llmsFull, /https:\/\/crewswarm\.ai\/pm-loop-walkthrough\.html/);
    assert.match(llmsFull, /## Engine comparison page/);
    assert.match(llmsFull, /https:\/\/crewswarm\.ai\/engine-comparison\.html/);
  });
});
