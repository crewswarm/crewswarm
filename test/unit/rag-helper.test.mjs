/**
 * Unit tests for lib/bridges/rag-helper.mjs
 *
 * Covers: fetchCrewCliRagContext (non-coding queries skip RAG),
 *         isRagServerAvailable (returns false when no server running)
 *
 * No network calls — these test the short-circuit paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchCrewCliRagContext,
  isRagServerAvailable,
} from "../../lib/bridges/rag-helper.mjs";

describe("rag-helper – fetchCrewCliRagContext", () => {
  it("returns empty string for non-coding query", async () => {
    const result = await fetchCrewCliRagContext("hello how are you");
    assert.equal(result, "");
  });

  it("returns empty string for greetings", async () => {
    const result = await fetchCrewCliRagContext("good morning");
    assert.equal(result, "");
  });

  it("returns empty string for coding query when server is down", async () => {
    // This hits fetch but server isn't running -> ECONNREFUSED -> returns ''
    const result = await fetchCrewCliRagContext("implement a new endpoint for users");
    assert.equal(result, "");
  });

  it("returns empty string for 'fix the bug' when server is down", async () => {
    const result = await fetchCrewCliRagContext("fix the login bug");
    assert.equal(result, "");
  });
});

describe("rag-helper – isRagServerAvailable", () => {
  it("returns false when no RAG server is running", async () => {
    const available = await isRagServerAvailable();
    assert.equal(available, false);
  });
});
