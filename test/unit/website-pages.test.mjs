import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const WEBSITE_DIR = path.join(ROOT, "website");

function readPage(name) {
  return fs.readFileSync(path.join(WEBSITE_DIR, name), "utf8");
}

describe("website pages", () => {
  it("new comparison and walkthrough pages exist with canonical URLs", () => {
    const comparison = readPage("engine-comparison.html");
    const walkthrough = readPage("pm-loop-walkthrough.html");

    assert.match(comparison, /<title>AI Coding Engine Comparison/i);
    assert.match(comparison, /rel="canonical" href="https:\/\/crewswarm\.ai\/engine-comparison\.html"/);

    assert.match(walkthrough, /<title>PM Loop Walkthrough/i);
    assert.match(walkthrough, /rel="canonical" href="https:\/\/crewswarm\.ai\/pm-loop-walkthrough\.html"/);
  });

  it("homepage links the PM loop, walkthrough, and engine comparison pages", () => {
    const home = readPage("index.html");
    assert.match(home, /href="pm-loop\.html"/);
    assert.match(home, /href="pm-loop-walkthrough\.html"/);
    assert.match(home, /href="engine-comparison\.html"/);
  });

  it("cli page links the engine comparison page", () => {
    const cli = readPage("cli.html");
    assert.match(cli, /Compare crew-cli with Claude, Codex, Cursor, Gemini, and OpenCode/i);
    assert.match(cli, /href="engine-comparison\.html"/);
    assert.match(cli, /href="pm-loop-walkthrough\.html"/);
  });

  it("pm-loop page links the walkthrough page", () => {
    const pmLoop = readPage("pm-loop.html");
    assert.match(pmLoop, /See a real walkthrough/i);
    assert.match(pmLoop, /href="pm-loop-walkthrough\.html"/);
  });

  it("docs, about, and comparison pages keep the sharpened launch messaging", () => {
    const docs = readPage("docs.html");
    const about = readPage("about.html");
    const compare = readPage("openclaw-comparison.html");

    assert.match(docs, /Install it fast\./i);
    assert.match(about, /Why crewswarm exists/i);
    assert.match(compare, /crewswarm runs the engineering crew/i);
  });
});
