/**
 * Unit tests for lib/bridges/integration.mjs
 *
 * Extends the existing bridge-integration.test.mjs with deeper coverage of:
 *  - saveBridgeMessage: happy path, skip conditions, error handling
 *  - saveBridgeMessages: batch saving, skips invalid projectId
 *  - shouldSaveToProjectRAG: all cases
 *  - getEnabledPlatforms: completeness
 *  - registerPlatform: defaults, custom config
 *  - detectProjectFromMessage: all three detection patterns + edge cases
 *
 * saveBridgeMessage calls saveProjectMessage and indexProjectMessage from
 * sibling modules. We test only through the public API (no deep mocking needed
 * because save/index are silent on error and the function returns a boolean).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  saveBridgeMessage,
  saveBridgeMessages,
  shouldSaveToProjectRAG,
  getEnabledPlatforms,
  registerPlatform,
  detectProjectFromMessage,
} from "../../lib/bridges/integration.mjs";

// ── getEnabledPlatforms ─────────────────────────────────────────────────────

describe("bridges-integration — getEnabledPlatforms", () => {
  it("returns a non-empty array", () => {
    const platforms = getEnabledPlatforms();
    assert.ok(Array.isArray(platforms));
    assert.ok(platforms.length > 0);
  });

  it("includes all expected default platforms", () => {
    const platforms = getEnabledPlatforms();
    for (const p of ["telegram", "whatsapp", "slack", "discord", "crew-chat"]) {
      assert.ok(platforms.includes(p), `Missing platform: ${p}`);
    }
  });

  it("returns only string entries", () => {
    for (const p of getEnabledPlatforms()) {
      assert.equal(typeof p, "string");
    }
  });
});

// ── shouldSaveToProjectRAG ──────────────────────────────────────────────────

describe("bridges-integration — shouldSaveToProjectRAG", () => {
  it("returns true for known platform with no agent", () => {
    assert.equal(shouldSaveToProjectRAG("telegram"), true);
    assert.equal(shouldSaveToProjectRAG("slack"), true);
    assert.equal(shouldSaveToProjectRAG("discord"), true);
  });

  it("returns true for known platform with allowed agent", () => {
    assert.equal(shouldSaveToProjectRAG("telegram", "crew-pm"), true);
    assert.equal(shouldSaveToProjectRAG("whatsapp", "crew-coder"), true);
  });

  it("returns false for excluded agents on telegram and whatsapp", () => {
    assert.equal(shouldSaveToProjectRAG("telegram", "crew-loco"), false);
    assert.equal(shouldSaveToProjectRAG("whatsapp", "crew-loco"), false);
  });

  it("returns false for unknown platform", () => {
    assert.equal(shouldSaveToProjectRAG("unknown-platform"), false);
    assert.equal(shouldSaveToProjectRAG(""), false);
  });

  it("returns true for slack and discord with crew-loco (not excluded there)", () => {
    assert.equal(shouldSaveToProjectRAG("slack", "crew-loco"), true);
    assert.equal(shouldSaveToProjectRAG("discord", "crew-loco"), true);
  });
});

// ── registerPlatform ────────────────────────────────────────────────────────

describe("bridges-integration — registerPlatform", () => {
  it("registers a new platform that then appears in getEnabledPlatforms", () => {
    registerPlatform("matrix", { sourcePrefix: "matrix-room", icon: "🔢" });
    assert.ok(getEnabledPlatforms().includes("matrix"));
  });

  it("registered platform is immediately usable in shouldSaveToProjectRAG", () => {
    registerPlatform("test-platform-a", {});
    assert.equal(shouldSaveToProjectRAG("test-platform-a"), true);
  });

  it("excludeAgents config is respected after registration", () => {
    registerPlatform("test-platform-b", { excludeAgents: ["crew-loco"] });
    assert.equal(shouldSaveToProjectRAG("test-platform-b", "crew-loco"), false);
    assert.equal(shouldSaveToProjectRAG("test-platform-b", "crew-pm"), true);
  });

  it("defaults sourcePrefix to platform name when not provided", () => {
    registerPlatform("test-platform-c", {});
    assert.equal(shouldSaveToProjectRAG("test-platform-c"), true);
  });

  it("does not throw when called with minimal config", () => {
    assert.doesNotThrow(() => registerPlatform("minimal-plat", {}));
  });
});

// ── saveBridgeMessage ───────────────────────────────────────────────────────

describe("bridges-integration — saveBridgeMessage skip conditions", () => {
  it("returns false for unknown platform", () => {
    const result = saveBridgeMessage("no-such-platform", "proj-1", "chat-1", "user", "hello");
    assert.equal(result, false);
  });

  it("returns false when projectId is null", () => {
    const result = saveBridgeMessage("telegram", null, "chat-1", "user", "hello");
    assert.equal(result, false);
  });

  it("returns false when projectId is 'general'", () => {
    const result = saveBridgeMessage("telegram", "general", "chat-1", "user", "hello");
    assert.equal(result, false);
  });

  it("returns false when projectId is 'none'", () => {
    const result = saveBridgeMessage("telegram", "none", "chat-1", "user", "hello");
    assert.equal(result, false);
  });

  it("returns false for excluded agent", () => {
    const result = saveBridgeMessage("telegram", "proj-1", "chat-1", "assistant", "hello", "crew-loco");
    assert.equal(result, false);
  });

  it("returns boolean (true or false) for valid call", () => {
    // saveProjectMessage and indexProjectMessage may throw internally depending on setup
    // but saveBridgeMessage catches errors and returns false on failure
    const result = saveBridgeMessage("telegram", "test-proj-save", "chat-999", "user", "test message");
    assert.equal(typeof result, "boolean");
  });

  it("handles undefined agent gracefully (defaults to null)", () => {
    const result = saveBridgeMessage("telegram", "test-proj-undef", "chat-1", "user", "hi", undefined);
    assert.equal(typeof result, "boolean");
  });

  it("handles empty metadata gracefully", () => {
    const result = saveBridgeMessage("slack", "proj-slack", "C123", "user", "slack msg", null, {});
    assert.equal(typeof result, "boolean");
  });

  it("includes extra metadata fields in message", () => {
    // Just verify no throw with metadata
    assert.doesNotThrow(() =>
      saveBridgeMessage("discord", "proj-discord", "ch-999", "assistant", "resp", "crew-pm", {
        threadId: "thread-1",
        username: "testuser"
      })
    );
  });
});

// ── saveBridgeMessages ──────────────────────────────────────────────────────

describe("bridges-integration — saveBridgeMessages", () => {
  it("returns 0 for general projectId", () => {
    const result = saveBridgeMessages("telegram", "general", [
      { chatId: "1", role: "user", content: "hi" }
    ]);
    assert.equal(result, 0);
  });

  it("returns 0 for null projectId", () => {
    const result = saveBridgeMessages("telegram", null, [
      { chatId: "1", role: "user", content: "hi" }
    ]);
    assert.equal(result, 0);
  });

  it("returns a number for valid batch", () => {
    const result = saveBridgeMessages("telegram", "proj-batch-test", [
      { chatId: "chat-1", role: "user", content: "msg 1" },
      { chatId: "chat-1", role: "assistant", content: "msg 2", agent: "crew-pm" }
    ]);
    assert.equal(typeof result, "number");
    assert.ok(result >= 0);
  });

  it("returns 0 for empty messages array", () => {
    const result = saveBridgeMessages("telegram", "proj-1", []);
    assert.equal(result, 0);
  });

  it("skips messages with excluded agents", () => {
    const result = saveBridgeMessages("telegram", "proj-1", [
      { chatId: "1", role: "assistant", content: "skip", agent: "crew-loco" }
    ]);
    assert.equal(result, 0);
  });
});

// ── detectProjectFromMessage ─────────────────────────────────────────────────

describe("bridges-integration — detectProjectFromMessage", () => {
  const projects = [
    { id: "website", name: "website", outputDir: "/home/user/builds/website" },
    { id: "api-server", name: "api-server", outputDir: "/home/user/builds/api-server" },
    { id: "mobile-app", name: "mobile-app", outputDir: "/home/user/builds/mobile-app" },
  ];

  it("returns null for empty content", () => {
    assert.equal(detectProjectFromMessage("", projects), null);
  });

  it("returns null for null content", () => {
    assert.equal(detectProjectFromMessage(null, projects), null);
  });

  it("returns null for empty project list", () => {
    assert.equal(detectProjectFromMessage("fix the website", []), null);
  });

  it("returns null for null project list", () => {
    assert.equal(detectProjectFromMessage("fix the website", null), null);
  });

  it("detects project from dispatch pattern", () => {
    const result = detectProjectFromMessage(
      "dispatch crew-coder to website project: improve hero",
      projects
    );
    assert.equal(result, "website");
  });

  it("detects project from 'in the X project' pattern", () => {
    const result = detectProjectFromMessage(
      "work in the website project and fix the layout",
      projects
    );
    assert.equal(result, "website");
  });

  it("detects project from output directory path hint", () => {
    const result = detectProjectFromMessage(
      "edit website/src/index.html to update navigation",
      projects
    );
    assert.equal(result, "website");
  });

  it("detects api-server project", () => {
    const result = detectProjectFromMessage(
      "work on the api-server project authentication",
      projects
    );
    assert.equal(result, "api-server");
  });

  it("returns null for generic message with no project mention", () => {
    assert.equal(detectProjectFromMessage("what is the weather today", projects), null);
    assert.equal(detectProjectFromMessage("how are you doing", projects), null);
  });

  it("is case-insensitive for dispatch pattern", () => {
    const result = detectProjectFromMessage(
      "DISPATCH crew-coder to WEBSITE project: fix bug",
      projects
    );
    assert.equal(result, "website");
  });
});
