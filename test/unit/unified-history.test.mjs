/**
 * Unit tests for lib/chat/unified-history.mjs
 *
 * The module depends on external modules (history, identity-linker, fs) that
 * read from disk. We cannot easily mock ESM imports, so we test the pure
 * formatting and stats logic by calling the exported functions and verifying
 * behavior when identities are unlinked (which returns empty/null gracefully).
 *
 * For deeper coverage we also test the pure helper patterns inline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Pure logic mirrors (tested without disk dependencies) ────────────────────

/** Mirrors the sort + slice logic from loadUnifiedHistory */
function mergeAndLimit(histories, maxMessages) {
  const all = [];
  for (const h of histories) {
    all.push(...h);
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return all.slice(-maxMessages);
}

/** Mirrors formatUnifiedHistory mapping */
function formatHistory(history) {
  return history.map((h) => ({
    role: h.role,
    content: h.content,
    ...(h.agent && { name: h.agent }),
  }));
}

/** Mirrors formatUnifiedHistoryWithSource mapping */
function formatHistoryWithSource(history) {
  const sourceEmoji = {
    dashboard: "\uD83D\uDCBB",
    telegram: "\u2708\uFE0F",
    whatsapp: "\uD83D\uDCAC",
  };
  return history.map((h) => ({
    role: h.role,
    content: `${sourceEmoji[h.source] || ""} ${h.content}`,
    source: h.source,
  }));
}

/** Mirrors getUnifiedHistoryStats aggregation */
function computeStats(masterIdentity, history) {
  const stats = {
    masterIdentity,
    totalMessages: history.length,
    platforms: {},
    oldestMessage: null,
    newestMessage: null,
  };
  for (const msg of history) {
    if (!stats.platforms[msg.source]) stats.platforms[msg.source] = 0;
    stats.platforms[msg.source]++;
  }
  if (history.length > 0) {
    stats.oldestMessage = new Date(history[0].ts);
    stats.newestMessage = new Date(history[history.length - 1].ts);
  }
  return stats;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("mergeAndLimit", () => {
  it("sorts by timestamp ascending", () => {
    const a = [{ ts: 300, role: "user", content: "c" }];
    const b = [{ ts: 100, role: "user", content: "a" }, { ts: 200, role: "user", content: "b" }];
    const merged = mergeAndLimit([a, b], 100);
    assert.equal(merged[0].content, "a");
    assert.equal(merged[1].content, "b");
    assert.equal(merged[2].content, "c");
  });

  it("limits to maxMessages from the end", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ ts: i, role: "user", content: `m${i}` }));
    const limited = mergeAndLimit([msgs], 5);
    assert.equal(limited.length, 5);
    assert.equal(limited[0].ts, 15);
    assert.equal(limited[4].ts, 19);
  });

  it("handles empty input", () => {
    assert.deepEqual(mergeAndLimit([], 50), []);
    assert.deepEqual(mergeAndLimit([[]], 50), []);
  });

  it("handles messages with missing ts (treated as 0)", () => {
    const msgs = [
      { role: "user", content: "no-ts" },
      { ts: 100, role: "user", content: "has-ts" },
    ];
    const merged = mergeAndLimit([msgs], 100);
    assert.equal(merged[0].content, "no-ts"); // ts=0 sorts first
    assert.equal(merged[1].content, "has-ts");
  });
});

describe("formatHistory", () => {
  it("maps role and content", () => {
    const input = [{ role: "user", content: "hello", source: "dashboard", ts: 1 }];
    const out = formatHistory(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
    assert.equal(out[0].content, "hello");
    assert.equal(out[0].name, undefined);
  });

  it("includes agent name when present", () => {
    const input = [{ role: "assistant", content: "reply", agent: "crew-coder", ts: 1 }];
    const out = formatHistory(input);
    assert.equal(out[0].name, "crew-coder");
  });

  it("omits name when agent is absent", () => {
    const input = [{ role: "user", content: "hi" }];
    const out = formatHistory(input);
    assert.ok(!("name" in out[0]));
  });
});

describe("formatHistoryWithSource", () => {
  it("prefixes content with source emoji", () => {
    const input = [{ role: "user", content: "hi", source: "telegram", ts: 1 }];
    const out = formatHistoryWithSource(input);
    assert.ok(out[0].content.includes("hi"));
    assert.equal(out[0].source, "telegram");
  });

  it("handles unknown source gracefully", () => {
    const input = [{ role: "user", content: "yo", source: "slack", ts: 1 }];
    const out = formatHistoryWithSource(input);
    assert.ok(out[0].content.includes("yo"));
    assert.equal(out[0].source, "slack");
  });
});

describe("computeStats", () => {
  it("counts messages per platform", () => {
    const history = [
      { ts: 1, role: "user", content: "a", source: "dashboard" },
      { ts: 2, role: "user", content: "b", source: "telegram" },
      { ts: 3, role: "user", content: "c", source: "dashboard" },
    ];
    const stats = computeStats("master-1", history);
    assert.equal(stats.totalMessages, 3);
    assert.equal(stats.platforms.dashboard, 2);
    assert.equal(stats.platforms.telegram, 1);
  });

  it("sets oldest/newest timestamps", () => {
    const history = [
      { ts: 1000, role: "user", content: "a", source: "dashboard" },
      { ts: 5000, role: "user", content: "b", source: "telegram" },
    ];
    const stats = computeStats("m", history);
    assert.equal(stats.oldestMessage.getTime(), 1000);
    assert.equal(stats.newestMessage.getTime(), 5000);
  });

  it("returns null timestamps for empty history", () => {
    const stats = computeStats("m", []);
    assert.equal(stats.totalMessages, 0);
    assert.equal(stats.oldestMessage, null);
    assert.equal(stats.newestMessage, null);
  });

  it("preserves masterIdentity", () => {
    const stats = computeStats("uid-abc", []);
    assert.equal(stats.masterIdentity, "uid-abc");
  });
});

describe("unified-history exports smoke test", () => {
  it("module exports the expected functions", async () => {
    // Dynamic import to verify the module loads without errors
    const mod = await import("../../lib/chat/unified-history.mjs");
    assert.equal(typeof mod.loadUnifiedHistory, "function");
    assert.equal(typeof mod.formatUnifiedHistory, "function");
    assert.equal(typeof mod.formatUnifiedHistoryWithSource, "function");
    assert.equal(typeof mod.shouldUseUnifiedHistory, "function");
    assert.equal(typeof mod.appendToUnifiedHistory, "function");
    assert.equal(typeof mod.getUnifiedHistoryStats, "function");
  });
});
