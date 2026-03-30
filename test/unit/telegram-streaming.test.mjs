/**
 * Unit tests for lib/integrations/telegram-streaming.mjs
 *
 * Covers: supportsNativeStreaming
 *
 * Skips: streamToTelegram (requires network + Telegram API)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { supportsNativeStreaming } from "../../lib/integrations/telegram-streaming.mjs";

describe("telegram-streaming – supportsNativeStreaming", () => {
  it("returns true for positive chat IDs (private chats)", () => {
    assert.equal(supportsNativeStreaming(12345), true);
    assert.equal(supportsNativeStreaming(1), true);
  });

  it("returns false for negative chat IDs (groups)", () => {
    assert.equal(supportsNativeStreaming(-100123456), false);
    assert.equal(supportsNativeStreaming(-1), false);
  });

  it("returns false for 0", () => {
    assert.equal(supportsNativeStreaming(0), false);
  });
});

describe("telegram-streaming – streamToTelegram smoke import", () => {
  it("streamToTelegram is an async function", async () => {
    const { streamToTelegram } = await import(
      "../../lib/integrations/telegram-streaming.mjs"
    );
    assert.ok(typeof streamToTelegram === "function");
  });
});
