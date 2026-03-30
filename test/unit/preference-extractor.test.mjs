/**
 * Unit tests for lib/preferences/extractor.mjs
 *
 * Covers:
 *  - extractPreferences: LLM-based extraction (mocked LLM caller)
 *  - autoExtractAndSave: convenience wrapper
 *  - extractAndSaveProfile: profile extraction + saving
 *  - shouldExtract: message count and keyword detection
 *  - buildPreferencePrompt: system prompt augmentation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  extractPreferences,
  autoExtractAndSave,
  extractAndSaveProfile,
  shouldExtract,
  buildPreferencePrompt,
} = await import("../../lib/preferences/extractor.mjs");

// ── shouldExtract ───────────────────────────────────────────────────────────

describe("preference-extractor — shouldExtract", () => {
  it("returns true at every 10th message", () => {
    assert.equal(shouldExtract(10), true);
    assert.equal(shouldExtract(20), true);
    assert.equal(shouldExtract(30), true);
  });

  it("returns false for non-10th messages without keywords", () => {
    assert.equal(shouldExtract(1, "hello"), false);
    assert.equal(shouldExtract(7, "how are you"), false);
    assert.equal(shouldExtract(15, "what time is it"), false);
  });

  it("returns true when preference keywords are detected", () => {
    assert.equal(shouldExtract(1, "I'm allergic to peanuts"), true);
    assert.equal(shouldExtract(3, "I am vegan"), true);
    assert.equal(shouldExtract(5, "I love Thai food"), true);
    assert.equal(shouldExtract(7, "my favorite restaurant"), true);
    assert.equal(shouldExtract(2, "I can't eat gluten"), true);
    assert.equal(shouldExtract(4, "I don't like spicy food"), true);
  });

  it("returns false for messageCount 0", () => {
    assert.equal(shouldExtract(0), false);
  });
});

// ── buildPreferencePrompt ───────────────────────────────────────────────────

describe("preference-extractor — buildPreferencePrompt", () => {
  it("returns base prompt unchanged when no preferences", () => {
    const base = "You are a helpful assistant.";
    const result = buildPreferencePrompt(base, {});
    assert.equal(result, base);
  });

  it("appends diet preference", () => {
    const result = buildPreferencePrompt("Base", { diet: "vegan" }, "Alice");
    assert.ok(result.includes("Diet: vegan"));
    assert.ok(result.includes("Alice"));
  });

  it("appends allergy warning", () => {
    const result = buildPreferencePrompt("Base", { allergies: ["peanut", "shellfish"] }, "Bob");
    assert.ok(result.includes("ALLERGIES: peanut, shellfish"));
    assert.ok(result.includes("NEVER recommend"));
  });

  it("appends location from contact", () => {
    const result = buildPreferencePrompt("Base", { diet: "omnivore" }, "User", {
      last_location: "Grand Bend, Ontario",
    });
    assert.ok(result.includes("Grand Bend, Ontario"));
  });

  it("appends work preferences", () => {
    const result = buildPreferencePrompt("Base", {
      preferredLanguages: ["TypeScript", "Python"],
      responseStyle: "concise",
    });
    assert.ok(result.includes("TypeScript, Python"));
    assert.ok(result.includes("Response style: concise"));
  });

  it("appends favorite cuisines", () => {
    const result = buildPreferencePrompt("Base", {
      favCuisines: ["Thai", "Mexican"],
    });
    assert.ok(result.includes("Thai, Mexican"));
  });
});

// ── extractPreferences ──────────────────────────────────────────────────────

describe("preference-extractor — extractPreferences", () => {
  it("returns empty object for empty history", async () => {
    const result = await extractPreferences([], async () => "{}");
    assert.deepEqual(result, {});
  });

  it("returns empty object for null history", async () => {
    const result = await extractPreferences(null, async () => "{}");
    assert.deepEqual(result, {});
  });

  it("parses LLM response as JSON", async () => {
    const mockLlm = async () => '{"diet": "vegan", "spiceLevel": "hot"}';
    const result = await extractPreferences(
      [{ role: "user", content: "I am vegan and love spicy food" }],
      mockLlm,
      "food"
    );
    assert.equal(result.diet, "vegan");
    assert.equal(result.spiceLevel, "hot");
  });

  it("strips markdown code fences from LLM response", async () => {
    const mockLlm = async () => '```json\n{"diet": "vegetarian"}\n```';
    const result = await extractPreferences(
      [{ role: "user", content: "I am vegetarian" }],
      mockLlm,
      "food"
    );
    assert.equal(result.diet, "vegetarian");
  });

  it("returns empty object when LLM returns invalid JSON", async () => {
    const mockLlm = async () => "not valid json at all";
    const result = await extractPreferences(
      [{ role: "user", content: "hello" }],
      mockLlm,
      "generic"
    );
    assert.deepEqual(result, {});
  });

  it("returns empty object when food domain has no required fields", async () => {
    const mockLlm = async () => '{"mood": "happy"}';
    const result = await extractPreferences(
      [{ role: "user", content: "I feel happy" }],
      mockLlm,
      "food"
    );
    // food domain requires diet, allergies, or favCuisines
    assert.deepEqual(result, {});
  });
});

// ── autoExtractAndSave ──────────────────────────────────────────────────────

describe("preference-extractor — autoExtractAndSave", () => {
  it("returns empty when history is too short", async () => {
    const mockLlm = async () => '{"diet": "vegan"}';
    const result = await autoExtractAndSave("user-1", mockLlm, "food", {
      getContactHistory: () => [{ role: "user", content: "hi" }],
      updatePreferences: () => {},
    });
    assert.deepEqual(result, {});
  });

  it("extracts and saves when enough history exists", async () => {
    const mockLlm = async () => '{"diet": "vegan"}';
    let savedPrefs = null;
    const result = await autoExtractAndSave("user-1", mockLlm, "food", {
      getContactHistory: () =>
        Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i}`,
        })),
      updatePreferences: (id, prefs) => {
        savedPrefs = prefs;
      },
    });
    assert.equal(result.diet, "vegan");
    assert.deepEqual(savedPrefs, { diet: "vegan" });
  });
});

// ── extractAndSaveProfile ───────────────────────────────────────────────────

describe("preference-extractor — extractAndSaveProfile", () => {
  it("returns empty for empty history", async () => {
    const result = await extractAndSaveProfile([], async () => "{}", "user-1", () => {});
    assert.deepEqual(result, {});
  });

  it("extracts and saves profile with location", async () => {
    const mockLlm = async () =>
      '{"city": "Toronto", "state": "Ontario", "country": "Canada", "phone": "+14161234567"}';
    let savedUpdates = null;
    const result = await extractAndSaveProfile(
      [{ role: "user", content: "I live in Toronto, Ontario, Canada. My number is +14161234567" }],
      mockLlm,
      "user-1",
      (id, updates) => {
        savedUpdates = updates;
      }
    );
    assert.equal(result.city, "Toronto");
    assert.ok(savedUpdates.last_location.includes("Toronto"));
    assert.equal(savedUpdates.phone_number, "+14161234567");
  });

  it("rejects invalid phone numbers", async () => {
    const mockLlm = async () => '{"phone": "not-a-phone"}';
    let savedUpdates = null;
    await extractAndSaveProfile(
      [{ role: "user", content: "call me at not-a-phone" }],
      mockLlm,
      "user-1",
      (id, updates) => {
        savedUpdates = updates;
      }
    );
    // Should not save invalid phone
    assert.ok(!savedUpdates || !savedUpdates.phone_number);
  });
});
