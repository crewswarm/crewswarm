/**
 * Unit tests for lib/chat/project-messages-rag.mjs
 *
 * The RAG module delegates persistence to the Collections system (SQLite /
 * better-sqlite3).  We test the pure-logic layer — title/content construction,
 * metadata field mapping, filter building, context formatting — by mirroring
 * the relevant logic inline, exactly as the existing unified-history tests do.
 *
 * We also do a smoke-test that all exports load correctly so we catch import
 * regressions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Pure-logic mirrors ────────────────────────────────────────────────────────

const SOURCE_EMOJI = {
  dashboard: "💻",
  cli: "⚡",
  "sub-agent": "👷",
  agent: "🤖",
};

/** Mirrors the title construction inside indexProjectMessage */
function buildTitle(message) {
  const emoji = SOURCE_EMOJI[message.source] || "📝";
  const agentLabel = message.agent ? ` [${message.agent}]` : "";
  const timestamp = new Date(message.ts).toLocaleString();
  return `${emoji} ${message.source}${agentLabel} — ${timestamp}`;
}

/** Mirrors the content+metadata construction inside indexProjectMessage */
function buildContent(message) {
  let content = message.content;
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    const metaContext = Object.entries(message.metadata)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    content += `\n\nContext: ${metaContext}`;
  }
  return content;
}

/** Mirrors the tags array construction inside indexProjectMessage */
function buildTags(projectId, message) {
  return [
    projectId,
    message.source,
    message.role,
    message.agent || "user",
  ].filter(Boolean);
}

/** Mirrors the result mapping inside searchProjectMessagesSemanticly */
function mapSearchResult(result) {
  return {
    projectId: result.metadata.projectId,
    messageId: result.metadata.messageId,
    source: result.metadata.source,
    role: result.metadata.role,
    agent: result.metadata.agent,
    timestamp: result.metadata.timestamp,
    content: result.content.split("\n\nContext:")[0],
    snippet: result.matchedText,
    score: result.score,
    threadId: result.metadata.threadId,
    parentId: result.metadata.parentId,
  };
}

/** Mirrors getConversationContext formatting */
function buildContext(projectId, results) {
  if (results.length === 0) return "";
  let context = "## Relevant Conversation History\n\n";
  context += `Found ${results.length} relevant messages from project "${projectId}":\n\n`;
  for (const result of results) {
    const emoji = { dashboard: "💻", cli: "⚡", "sub-agent": "👷" }[result.source] || "📝";
    const agentLabel = result.agent ? ` [${result.agent}]` : "";
    const date = new Date(result.timestamp).toLocaleDateString();
    context += `${emoji} **${result.source}**${agentLabel} (${date}):\n`;
    context += `${result.content.slice(0, 300)}${result.content.length > 300 ? "..." : ""}\n\n`;
  }
  return context;
}

/** Mirrors getIndexStats aggregation */
function computeIndexStats(allItems) {
  const byProject = {};
  const bySource = {};
  for (const item of allItems) {
    const meta = item.metadata;
    byProject[meta.projectId] = (byProject[meta.projectId] || 0) + 1;
    bySource[meta.source] = (bySource[meta.source] || 0) + 1;
  }
  const timestamps = allItems.map((i) => i.metadata.timestamp);
  return {
    totalIndexed: allItems.length,
    projectCount: Object.keys(byProject).length,
    byProject,
    bySource,
    oldestMessage: allItems.length > 0 ? new Date(Math.min(...timestamps)) : null,
    newestMessage: allItems.length > 0 ? new Date(Math.max(...timestamps)) : null,
  };
}

// ── Sample data factory ───────────────────────────────────────────────────────

function msg(overrides = {}) {
  return {
    id: "msg-001",
    ts: 1_700_000_000_000,
    source: "dashboard",
    role: "user",
    content: "discuss authentication",
    agent: null,
    threadId: null,
    parentId: null,
    metadata: {},
    ...overrides,
  };
}

// ── buildTitle ────────────────────────────────────────────────────────────────

describe("buildTitle", () => {
  it("uses correct emoji for known sources", () => {
    assert.ok(buildTitle(msg({ source: "dashboard" })).startsWith("💻"));
    assert.ok(buildTitle(msg({ source: "cli" })).startsWith("⚡"));
    assert.ok(buildTitle(msg({ source: "sub-agent" })).startsWith("👷"));
    assert.ok(buildTitle(msg({ source: "agent" })).startsWith("🤖"));
  });

  it("uses fallback emoji for unknown source", () => {
    assert.ok(buildTitle(msg({ source: "slack" })).startsWith("📝"));
  });

  it("includes agent label when agent is set", () => {
    const title = buildTitle(msg({ agent: "crew-qa" }));
    assert.ok(title.includes("[crew-qa]"));
  });

  it("omits agent label when agent is null", () => {
    const title = buildTitle(msg({ agent: null }));
    assert.ok(!title.includes("["));
  });

  it("includes the source name in the title", () => {
    const title = buildTitle(msg({ source: "cli" }));
    assert.ok(title.includes("cli"));
  });
});

// ── buildContent ──────────────────────────────────────────────────────────────

describe("buildContent", () => {
  it("returns message content unchanged when metadata is empty", () => {
    const m = msg({ content: "hello", metadata: {} });
    assert.equal(buildContent(m), "hello");
  });

  it("appends metadata context when metadata has entries", () => {
    const m = msg({ content: "hello", metadata: { foo: "bar", num: 42 } });
    const out = buildContent(m);
    assert.ok(out.startsWith("hello\n\nContext:"));
    assert.ok(out.includes("foo: bar"));
    assert.ok(out.includes("num: 42"));
  });

  it("does not append context when metadata is null/undefined", () => {
    const m = msg({ content: "hello", metadata: null });
    // Should not throw and should return content
    assert.equal(buildContent(m), "hello");
  });
});

// ── buildTags ─────────────────────────────────────────────────────────────────

describe("buildTags", () => {
  it("includes projectId, source, role, agent", () => {
    const tags = buildTags("proj-1", msg({ agent: "crew-qa", source: "sub-agent", role: "assistant" }));
    assert.ok(tags.includes("proj-1"));
    assert.ok(tags.includes("sub-agent"));
    assert.ok(tags.includes("assistant"));
    assert.ok(tags.includes("crew-qa"));
  });

  it("uses 'user' as default tag when agent is null", () => {
    const tags = buildTags("proj-x", msg({ agent: null }));
    assert.ok(tags.includes("user"));
  });

  it("filters out falsy values", () => {
    const tags = buildTags("proj-y", msg({ agent: null, source: "dashboard", role: "user" }));
    for (const t of tags) {
      assert.ok(t); // no empty strings, nulls, or undefined
    }
  });
});

// ── mapSearchResult ───────────────────────────────────────────────────────────

describe("mapSearchResult", () => {
  const fakeResult = {
    content: "discuss auth\n\nContext: foo: bar",
    matchedText: "auth",
    score: 0.9,
    metadata: {
      projectId: "proj-1",
      messageId: "msg-001",
      source: "dashboard",
      role: "user",
      agent: null,
      timestamp: 1_700_000_000_000,
      threadId: "t-1",
      parentId: null,
    },
  };

  it("strips Context section from content", () => {
    const mapped = mapSearchResult(fakeResult);
    assert.equal(mapped.content, "discuss auth");
  });

  it("preserves all expected fields", () => {
    const mapped = mapSearchResult(fakeResult);
    assert.equal(mapped.projectId, "proj-1");
    assert.equal(mapped.messageId, "msg-001");
    assert.equal(mapped.source, "dashboard");
    assert.equal(mapped.role, "user");
    assert.equal(mapped.score, 0.9);
    assert.equal(mapped.snippet, "auth");
    assert.equal(mapped.threadId, "t-1");
    assert.equal(mapped.parentId, null);
  });

  it("handles content with no Context section", () => {
    const r = { ...fakeResult, content: "plain content" };
    const mapped = mapSearchResult(r);
    assert.equal(mapped.content, "plain content");
  });
});

// ── buildContext ──────────────────────────────────────────────────────────────

describe("buildContext", () => {
  it("returns empty string when results are empty", () => {
    assert.equal(buildContext("proj-1", []), "");
  });

  it("includes project ID in heading", () => {
    const results = [
      {
        source: "dashboard",
        agent: null,
        timestamp: 1_700_000_000_000,
        content: "some discussion",
      },
    ];
    const ctx = buildContext("my-project", results);
    assert.ok(ctx.includes("my-project"));
    assert.ok(ctx.includes("## Relevant Conversation History"));
  });

  it("prefixes each result with source emoji", () => {
    const results = [
      { source: "cli", agent: null, timestamp: 1_700_000_000_000, content: "cli message" },
    ];
    const ctx = buildContext("p", results);
    assert.ok(ctx.includes("⚡"));
  });

  it("includes agent label when agent is set", () => {
    const results = [
      { source: "sub-agent", agent: "crew-qa", timestamp: 1_700_000_000_000, content: "qa response" },
    ];
    const ctx = buildContext("p", results);
    assert.ok(ctx.includes("[crew-qa]"));
  });

  it("truncates long content to 300 chars and adds ellipsis", () => {
    const longContent = "X".repeat(400);
    const results = [
      { source: "dashboard", agent: null, timestamp: 1_700_000_000_000, content: longContent },
    ];
    const ctx = buildContext("p", results);
    assert.ok(ctx.includes("..."));
  });

  it("does not add ellipsis for short content", () => {
    const results = [
      { source: "dashboard", agent: null, timestamp: 1_700_000_000_000, content: "short" },
    ];
    const ctx = buildContext("p", results);
    // The context itself has "..." in the truncation template but the content line shouldn't
    const lines = ctx.split("\n");
    const contentLine = lines.find((l) => l.includes("short"));
    assert.ok(contentLine && !contentLine.endsWith("..."));
  });

  it("counts results in heading", () => {
    const results = [
      { source: "dashboard", agent: null, timestamp: 1_700_000_000_000, content: "a" },
      { source: "cli", agent: null, timestamp: 1_700_000_000_000, content: "b" },
    ];
    const ctx = buildContext("p", results);
    assert.ok(ctx.includes("Found 2 relevant messages"));
  });
});

// ── computeIndexStats ─────────────────────────────────────────────────────────

describe("computeIndexStats", () => {
  it("returns zero counts for empty collection", () => {
    const stats = computeIndexStats([]);
    assert.equal(stats.totalIndexed, 0);
    assert.equal(stats.projectCount, 0);
    assert.equal(stats.oldestMessage, null);
    assert.equal(stats.newestMessage, null);
  });

  it("counts by project correctly", () => {
    const items = [
      { metadata: { projectId: "A", source: "cli", timestamp: 1000 } },
      { metadata: { projectId: "A", source: "cli", timestamp: 2000 } },
      { metadata: { projectId: "B", source: "dashboard", timestamp: 3000 } },
    ];
    const stats = computeIndexStats(items);
    assert.equal(stats.totalIndexed, 3);
    assert.equal(stats.projectCount, 2);
    assert.equal(stats.byProject["A"], 2);
    assert.equal(stats.byProject["B"], 1);
  });

  it("counts by source correctly", () => {
    const items = [
      { metadata: { projectId: "A", source: "cli", timestamp: 1000 } },
      { metadata: { projectId: "A", source: "dashboard", timestamp: 2000 } },
      { metadata: { projectId: "B", source: "cli", timestamp: 3000 } },
    ];
    const stats = computeIndexStats(items);
    assert.equal(stats.bySource.cli, 2);
    assert.equal(stats.bySource.dashboard, 1);
  });

  it("computes oldest and newest message timestamps", () => {
    const items = [
      { metadata: { projectId: "A", source: "cli", timestamp: 5000 } },
      { metadata: { projectId: "A", source: "cli", timestamp: 1000 } },
      { metadata: { projectId: "A", source: "cli", timestamp: 3000 } },
    ];
    const stats = computeIndexStats(items);
    assert.equal(stats.oldestMessage.getTime(), 1000);
    assert.equal(stats.newestMessage.getTime(), 5000);
  });
});

// ── Export smoke test ─────────────────────────────────────────────────────────

describe("project-messages-rag exports smoke test", () => {
  it("module exports the expected functions", async () => {
    const mod = await import("../../lib/chat/project-messages-rag.mjs");
    const expected = [
      "getProjectMessagesCollection",
      "indexProjectMessage",
      "indexProjectMessages",
      "indexAllProjects",
      "searchProjectMessagesSemanticly",
      "getConversationContext",
      "getIndexStats",
      "autoIndexMessage",
    ];
    for (const fn of expected) {
      assert.equal(typeof mod[fn], "function", `Missing export: ${fn}`);
    }
  });
});
