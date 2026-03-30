/**
 * Unit tests for lib/agents/platform-formatting.mjs
 *
 * Covers: getPlatformFormatting, TELEGRAM_FORMATTING,
 *         WHATSAPP_FORMATTING, DASHBOARD_FORMATTING
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getPlatformFormatting,
  TELEGRAM_FORMATTING,
  WHATSAPP_FORMATTING,
  DASHBOARD_FORMATTING,
} from "../../lib/agents/platform-formatting.mjs";

describe("platform-formatting – constants", () => {
  it("TELEGRAM_FORMATTING is a non-empty string", () => {
    assert.ok(typeof TELEGRAM_FORMATTING === "string");
    assert.ok(TELEGRAM_FORMATTING.length > 50);
  });

  it("WHATSAPP_FORMATTING is a non-empty string", () => {
    assert.ok(typeof WHATSAPP_FORMATTING === "string");
    assert.ok(WHATSAPP_FORMATTING.length > 50);
  });

  it("DASHBOARD_FORMATTING is a non-empty string", () => {
    assert.ok(typeof DASHBOARD_FORMATTING === "string");
    assert.ok(DASHBOARD_FORMATTING.length > 20);
  });
});

describe("platform-formatting – getPlatformFormatting", () => {
  it("returns Telegram formatting for 'telegram'", () => {
    assert.equal(getPlatformFormatting("telegram"), TELEGRAM_FORMATTING);
  });

  it("returns WhatsApp formatting for 'whatsapp'", () => {
    assert.equal(getPlatformFormatting("whatsapp"), WHATSAPP_FORMATTING);
  });

  it("returns Dashboard formatting for 'dashboard'", () => {
    assert.equal(getPlatformFormatting("dashboard"), DASHBOARD_FORMATTING);
  });

  it("returns empty string for null", () => {
    assert.equal(getPlatformFormatting(null), "");
  });

  it("returns empty string for unknown platform", () => {
    assert.equal(getPlatformFormatting("discord"), "");
  });

  it("returns empty string for undefined", () => {
    assert.equal(getPlatformFormatting(undefined), "");
  });
});
