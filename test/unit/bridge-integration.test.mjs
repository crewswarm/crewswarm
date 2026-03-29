import test from "node:test";
import assert from "node:assert/strict";

import integration from "../../lib/bridges/integration.mjs";

const {
  shouldSaveToProjectRAG,
  getEnabledPlatforms,
  registerPlatform,
  detectProjectFromMessage,
} = integration;

test("bridge integration exposes expected built-in platforms", () => {
  const enabled = getEnabledPlatforms();
  assert.ok(enabled.includes("telegram"));
  assert.ok(enabled.includes("whatsapp"));
  assert.ok(enabled.includes("crew-chat"));
});

test("bridge integration excludes chat-only agents from project RAG where configured", () => {
  assert.equal(shouldSaveToProjectRAG("telegram", "crew-loco"), false);
  assert.equal(shouldSaveToProjectRAG("whatsapp", "crew-loco"), false);
  assert.equal(shouldSaveToProjectRAG("telegram", "crew-pm"), true);
});

test("bridge integration can register new platforms dynamically", () => {
  registerPlatform("signal", { sourcePrefix: "signal-chat", icon: "📶", excludeAgents: ["crew-loco"] });
  assert.ok(getEnabledPlatforms().includes("signal"));
  assert.equal(shouldSaveToProjectRAG("signal", "crew-loco"), false);
  assert.equal(shouldSaveToProjectRAG("signal", "crew-main"), true);
});

test("project detection finds explicit project mentions and output-dir path hints", () => {
  const projects = [
    { id: "website", name: "website", outputDir: "/tmp/builds/website" },
    { id: "crew-cli", name: "crew-cli", outputDir: "/tmp/builds/crew-cli" },
  ];

  assert.equal(
    detectProjectFromMessage("dispatch crew-coder to website project: improve hero copy", projects),
    "website",
  );
  assert.equal(
    detectProjectFromMessage("Please edit crew-cli/src/index.ts and tighten routing", projects),
    "crew-cli",
  );
  assert.equal(
    detectProjectFromMessage("work on the website project next", projects),
    "website",
  );
  assert.equal(
    detectProjectFromMessage("general chat with no project context", projects),
    null,
  );
});
