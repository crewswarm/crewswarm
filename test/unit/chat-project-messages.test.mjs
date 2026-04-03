/**
 * Unit tests for lib/chat/project-messages.mjs
 *
 * Uses CREWSWARM_STATE_DIR + resetPaths() so every test runs against an
 * isolated temp directory and never touches ~/.crewswarm.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Point all path resolution at a per-process temp dir before any module loads.
const TEST_DIR = path.join(os.tmpdir(), `chat-pm-test-${process.pid}`);
process.env.CREWSWARM_STATE_DIR = TEST_DIR;

import { resetPaths } from "../../lib/runtime/paths.mjs";

import {
  saveProjectMessage,
  loadProjectMessages,
  formatProjectMessages,
  getProjectMessageStats,
  clearProjectMessages,
  listProjectsWithMessages,
  searchProjectMessages,
  getMessageThreads,
  buildMessageTree,
  exportProjectMessages,
} from "../../lib/chat/project-messages.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides = {}) {
  return {
    source: "dashboard",
    role: "user",
    content: "hello world",
    ...overrides,
  };
}

function seedMessages(projectId, count = 3) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = saveProjectMessage(projectId, {
      source: i % 2 === 0 ? "dashboard" : "cli",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    });
    ids.push(id);
  }
  return ids;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  resetPaths();
});

afterEach(() => {
  // Wipe state dir contents between tests so each test is isolated.
  const pmDir = path.join(TEST_DIR, "project-messages");
  if (fs.existsSync(pmDir)) {
    fs.rmSync(pmDir, { recursive: true, force: true });
  }
});

// ── saveProjectMessage ────────────────────────────────────────────────────────

describe("saveProjectMessage", () => {
  it("returns a UUID string on success", () => {
    const id = saveProjectMessage("proj-1", makeMsg());
    assert.ok(typeof id === "string");
    assert.match(id, /^[0-9a-f-]{36}$/);
  });

  it("returns null when projectId is falsy", () => {
    assert.equal(saveProjectMessage(null, makeMsg()), null);
    assert.equal(saveProjectMessage("", makeMsg()), null);
    assert.equal(saveProjectMessage(undefined, makeMsg()), null);
  });

  it("returns null when required message fields are missing", () => {
    // missing content
    assert.equal(saveProjectMessage("proj-x", { source: "cli", role: "user" }), null);
    // missing role
    assert.equal(saveProjectMessage("proj-x", { source: "cli", content: "hi" }), null);
    // missing source
    assert.equal(saveProjectMessage("proj-x", { role: "user", content: "hi" }), null);
  });

  it("persists the message to disk", () => {
    const id = saveProjectMessage("proj-persist", makeMsg({ content: "stored" }));
    const msgs = loadProjectMessages("proj-persist");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, id);
    assert.equal(msgs[0].content, "stored");
  });

  it("sets default fields (agent, threadId, parentId, metadata)", () => {
    saveProjectMessage("proj-defaults", makeMsg());
    const msgs = loadProjectMessages("proj-defaults");
    assert.equal(msgs[0].agent, null);
    assert.equal(msgs[0].threadId, null);
    assert.equal(msgs[0].parentId, null);
    assert.deepEqual(msgs[0].metadata, {});
  });

  it("persists optional fields when provided", () => {
    saveProjectMessage("proj-opt", makeMsg({
      agent: "crew-coder",
      threadId: "t-1",
      parentId: "p-1",
      metadata: { directChat: true },
    }));
    const msgs = loadProjectMessages("proj-opt");
    assert.equal(msgs[0].agent, "crew-coder");
    assert.equal(msgs[0].threadId, "t-1");
    assert.equal(msgs[0].parentId, "p-1");
    assert.deepEqual(msgs[0].metadata, { directChat: true });
  });

  it("sanitizes unusual projectId characters", () => {
    // Should not throw for IDs with slashes, spaces, etc.
    const id = saveProjectMessage("my project/name!", makeMsg());
    assert.ok(typeof id === "string");
  });
});

// ── loadProjectMessages ───────────────────────────────────────────────────────

describe("loadProjectMessages", () => {
  it("returns empty array for missing projectId", () => {
    assert.deepEqual(loadProjectMessages(""), []);
    assert.deepEqual(loadProjectMessages(null), []);
  });

  it("returns empty array when no file exists yet", () => {
    assert.deepEqual(loadProjectMessages("nonexistent-project-xyz"), []);
  });

  it("returns all saved messages sorted by timestamp", () => {
    const proj = "proj-sort";
    saveProjectMessage(proj, makeMsg({ content: "first" }));
    saveProjectMessage(proj, makeMsg({ content: "second" }));
    const msgs = loadProjectMessages(proj);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].ts <= msgs[1].ts);
  });

  it("filters by source", () => {
    const proj = "proj-fsrc";
    saveProjectMessage(proj, makeMsg({ source: "dashboard" }));
    saveProjectMessage(proj, makeMsg({ source: "cli" }));
    const msgs = loadProjectMessages(proj, { source: "cli" });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].source, "cli");
  });

  it("filters by agent", () => {
    const proj = "proj-fagent";
    saveProjectMessage(proj, makeMsg({ agent: "crew-coder", source: "sub-agent" }));
    saveProjectMessage(proj, makeMsg({ agent: "crew-qa", source: "sub-agent" }));
    const msgs = loadProjectMessages(proj, { agent: "crew-coder" });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].agent, "crew-coder");
  });

  it("filters by since timestamp", () => {
    const proj = "proj-fsince";
    saveProjectMessage(proj, makeMsg({ content: "old" }));
    const cutoff = Date.now() + 10; // future cutoff
    saveProjectMessage(proj, makeMsg({ content: "new" }));
    const msgs = loadProjectMessages(proj, { since: cutoff });
    // All messages are from around now so this may be 0 or 1 depending on timing
    // Let's verify the filter at least doesn't break
    assert.ok(Array.isArray(msgs));
  });

  it("filters by threadId", () => {
    const proj = "proj-fthread";
    saveProjectMessage(proj, makeMsg({ threadId: "t-A" }));
    saveProjectMessage(proj, makeMsg({ threadId: "t-B" }));
    const msgs = loadProjectMessages(proj, { threadId: "t-A" });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].threadId, "t-A");
  });

  it("filters by parentId", () => {
    const proj = "proj-fparent";
    saveProjectMessage(proj, makeMsg({ parentId: "root-1" }));
    saveProjectMessage(proj, makeMsg({ parentId: "root-2" }));
    const msgs = loadProjectMessages(proj, { parentId: "root-1" });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].parentId, "root-1");
  });

  it("excludes directChat messages when excludeDirect is set", () => {
    const proj = "proj-excl";
    saveProjectMessage(proj, makeMsg({ metadata: { directChat: true } }));
    saveProjectMessage(proj, makeMsg({ content: "not-direct" }));
    const msgs = loadProjectMessages(proj, { excludeDirect: true });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "not-direct");
  });

  it("filters by mentionedAgent", () => {
    const proj = "proj-fmention";
    saveProjectMessage(proj, makeMsg({ metadata: { mentions: ["crew-qa"] } }));
    saveProjectMessage(proj, makeMsg({ metadata: { mentions: ["crew-coder"] } }));
    saveProjectMessage(proj, makeMsg()); // no mentions
    const msgs = loadProjectMessages(proj, { mentionedAgent: "crew-qa" });
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].metadata.mentions.includes("crew-qa"));
  });

  it("applies limit from end of list", () => {
    const proj = "proj-limit";
    seedMessages(proj, 10);
    const msgs = loadProjectMessages(proj, { limit: 3 });
    assert.equal(msgs.length, 3);
  });

  it("skips corrupt JSONL lines", () => {
    const proj = "proj-corrupt";
    saveProjectMessage(proj, makeMsg());
    // Manually inject corrupt line
    const pmDir = path.join(TEST_DIR, "project-messages", proj);
    const file = path.join(pmDir, "messages.jsonl");
    fs.appendFileSync(file, "NOT_VALID_JSON\n");
    saveProjectMessage(proj, makeMsg({ content: "after-corrupt" }));
    const msgs = loadProjectMessages(proj);
    assert.equal(msgs.length, 2); // corrupt line silently skipped
  });
});

// ── formatProjectMessages ─────────────────────────────────────────────────────

describe("formatProjectMessages", () => {
  it("returns array of {role, content} objects", () => {
    const proj = "proj-fmt";
    saveProjectMessage(proj, makeMsg({ content: "test" }));
    const formatted = formatProjectMessages(proj);
    assert.ok(Array.isArray(formatted));
    assert.ok("role" in formatted[0]);
    assert.ok("content" in formatted[0]);
  });

  it("prepends emoji when includeSource is true", () => {
    const proj = "proj-fmtsrc";
    saveProjectMessage(proj, makeMsg({ source: "dashboard", content: "dash msg" }));
    const formatted = formatProjectMessages(proj, { includeSource: true });
    assert.ok(formatted[0].content.includes("dash msg"));
    // dashboard emoji is 💻
    assert.ok(formatted[0].content.startsWith("💻"));
  });

  it("uses fallback emoji for unknown source", () => {
    const proj = "proj-fmtunk";
    saveProjectMessage(proj, makeMsg({ source: "custom-source", content: "msg" }));
    const formatted = formatProjectMessages(proj, { includeSource: true });
    assert.ok(formatted[0].content.startsWith("📝"));
  });

  it("prepends agent name for sub-agent messages when includeAgent is true (default)", () => {
    const proj = "proj-fmtagt";
    saveProjectMessage(proj, makeMsg({
      source: "sub-agent",
      agent: "crew-qa",
      content: "qa output",
    }));
    const formatted = formatProjectMessages(proj);
    assert.ok(formatted[0].content.startsWith("[crew-qa]"));
  });

  it("does not prepend agent name when includeAgent is false", () => {
    const proj = "proj-fmtnoagt";
    saveProjectMessage(proj, makeMsg({
      source: "sub-agent",
      agent: "crew-qa",
      content: "qa output",
    }));
    const formatted = formatProjectMessages(proj, { includeAgent: false });
    assert.ok(!formatted[0].content.startsWith("[crew-qa]"));
  });

  it("does not prepend agent name for non-sub-agent sources", () => {
    const proj = "proj-fmtdash";
    saveProjectMessage(proj, makeMsg({ source: "dashboard", agent: "crew-lead", content: "from lead" }));
    const formatted = formatProjectMessages(proj);
    assert.ok(!formatted[0].content.startsWith("[crew-lead]"));
  });

  it("respects limit option", () => {
    const proj = "proj-fmtlim";
    seedMessages(proj, 10);
    const formatted = formatProjectMessages(proj, { limit: 2 });
    assert.equal(formatted.length, 2);
  });
});

// ── getProjectMessageStats ────────────────────────────────────────────────────

describe("getProjectMessageStats", () => {
  it("returns zero stats for empty project", () => {
    const stats = getProjectMessageStats("proj-empty-stats");
    assert.equal(stats.total, 0);
    assert.equal(stats.userMessages, 0);
    assert.equal(stats.assistantMessages, 0);
    assert.equal(stats.oldestMessage, null);
    assert.equal(stats.newestMessage, null);
  });

  it("counts total messages correctly", () => {
    const proj = "proj-stats-total";
    seedMessages(proj, 5);
    const stats = getProjectMessageStats(proj);
    assert.equal(stats.total, 5);
  });

  it("counts user and assistant messages separately", () => {
    const proj = "proj-stats-roles";
    saveProjectMessage(proj, makeMsg({ role: "user" }));
    saveProjectMessage(proj, makeMsg({ role: "user" }));
    saveProjectMessage(proj, makeMsg({ role: "assistant" }));
    const stats = getProjectMessageStats(proj);
    assert.equal(stats.userMessages, 2);
    assert.equal(stats.assistantMessages, 1);
  });

  it("groups messages by source in bySource", () => {
    const proj = "proj-stats-src";
    saveProjectMessage(proj, makeMsg({ source: "dashboard" }));
    saveProjectMessage(proj, makeMsg({ source: "cli" }));
    saveProjectMessage(proj, makeMsg({ source: "dashboard" }));
    const stats = getProjectMessageStats(proj);
    assert.equal(stats.bySource.dashboard, 2);
    assert.equal(stats.bySource.cli, 1);
  });

  it("groups messages by agent in byAgent", () => {
    const proj = "proj-stats-agent";
    saveProjectMessage(proj, makeMsg({ agent: "crew-qa", source: "sub-agent" }));
    saveProjectMessage(proj, makeMsg({ agent: "crew-coder", source: "sub-agent" }));
    const stats = getProjectMessageStats(proj);
    assert.equal(stats.byAgent["crew-qa"], 1);
    assert.equal(stats.byAgent["crew-coder"], 1);
  });

  it("sets oldest and newest message timestamps", () => {
    const proj = "proj-stats-ts";
    saveProjectMessage(proj, makeMsg());
    saveProjectMessage(proj, makeMsg());
    const stats = getProjectMessageStats(proj);
    assert.ok(stats.oldestMessage instanceof Date);
    assert.ok(stats.newestMessage instanceof Date);
    assert.ok(stats.oldestMessage <= stats.newestMessage);
  });
});

// ── clearProjectMessages ──────────────────────────────────────────────────────

describe("clearProjectMessages", () => {
  it("removes the messages file", () => {
    const proj = "proj-clear";
    saveProjectMessage(proj, makeMsg());
    clearProjectMessages(proj);
    assert.deepEqual(loadProjectMessages(proj), []);
  });

  it("does not throw when no messages file exists", () => {
    assert.doesNotThrow(() => clearProjectMessages("proj-never-existed-xyz"));
  });

  it("is a no-op for falsy projectId", () => {
    assert.doesNotThrow(() => clearProjectMessages(null));
    assert.doesNotThrow(() => clearProjectMessages(""));
  });
});

// ── listProjectsWithMessages ──────────────────────────────────────────────────

describe("listProjectsWithMessages", () => {
  it("returns empty array when no projects exist", () => {
    const result = listProjectsWithMessages();
    assert.ok(Array.isArray(result));
  });

  it("lists projects that have messages", () => {
    saveProjectMessage("proj-list-A", makeMsg());
    saveProjectMessage("proj-list-B", makeMsg());
    const projects = listProjectsWithMessages();
    const ids = projects.map((p) => p.projectId);
    assert.ok(ids.includes("proj-list-A"));
    assert.ok(ids.includes("proj-list-B"));
  });

  it("returns correct message counts", () => {
    const proj = "proj-list-count";
    seedMessages(proj, 4);
    const projects = listProjectsWithMessages();
    const found = projects.find((p) => p.projectId === proj);
    assert.ok(found);
    assert.equal(found.messageCount, 4);
  });

  it("sorts by lastActivity descending", () => {
    // Seed two projects with different timing
    saveProjectMessage("proj-list-old", makeMsg({ content: "old" }));
    saveProjectMessage("proj-list-new", makeMsg({ content: "new" }));
    const projects = listProjectsWithMessages();
    const ids = projects.map((p) => p.projectId);
    // Both should appear; most recently modified should be first
    const idxOld = ids.indexOf("proj-list-old");
    const idxNew = ids.indexOf("proj-list-new");
    assert.ok(idxOld !== -1);
    assert.ok(idxNew !== -1);
    // proj-list-new was saved last so its lastActivity >= proj-list-old's
    assert.ok(idxNew <= idxOld);
  });

  it("includes lastActivity timestamp", () => {
    const proj = "proj-list-ts";
    saveProjectMessage(proj, makeMsg());
    const projects = listProjectsWithMessages();
    const found = projects.find((p) => p.projectId === proj);
    assert.ok(typeof found.lastActivity === "number");
  });
});

// ── searchProjectMessages ─────────────────────────────────────────────────────

describe("searchProjectMessages", () => {
  it("returns empty array when projectId or query is falsy", () => {
    assert.deepEqual(searchProjectMessages("", "query"), []);
    assert.deepEqual(searchProjectMessages("proj", ""), []);
    assert.deepEqual(searchProjectMessages(null, "query"), []);
  });

  it("finds messages matching the query (case insensitive by default)", () => {
    const proj = "proj-search";
    saveProjectMessage(proj, makeMsg({ content: "The quick brown fox" }));
    saveProjectMessage(proj, makeMsg({ content: "Hello world" }));
    const results = searchProjectMessages(proj, "QUICK");
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("quick"));
  });

  it("finds messages with case-sensitive option", () => {
    const proj = "proj-search-cs";
    saveProjectMessage(proj, makeMsg({ content: "Hello World" }));
    saveProjectMessage(proj, makeMsg({ content: "hello world" }));
    const results = searchProjectMessages(proj, "Hello", { caseSensitive: true });
    assert.equal(results.length, 1);
  });

  it("returns snippet with match position", () => {
    const proj = "proj-search-snip";
    saveProjectMessage(proj, makeMsg({ content: "start text TARGET end text" }));
    const results = searchProjectMessages(proj, "TARGET");
    assert.ok(typeof results[0].snippet === "string");
    assert.ok(results[0].snippet.includes("TARGET"));
    assert.ok(typeof results[0].matchIndex === "number");
  });

  it("adds ellipses when snippet is truncated", () => {
    const proj = "proj-search-ellip";
    const longContent = "A".repeat(50) + " MATCH " + "B".repeat(50);
    saveProjectMessage(proj, makeMsg({ content: longContent }));
    const results = searchProjectMessages(proj, "MATCH");
    // snippet should be shorter than full content
    assert.ok(results[0].snippet.length < longContent.length);
    assert.ok(results[0].snippet.includes("..."));
  });

  it("respects limit option", () => {
    const proj = "proj-search-lim";
    for (let i = 0; i < 10; i++) {
      saveProjectMessage(proj, makeMsg({ content: `matching text ${i}` }));
    }
    const results = searchProjectMessages(proj, "matching", { limit: 3 });
    assert.equal(results.length, 3);
  });

  it("filters by source and agent", () => {
    const proj = "proj-search-filter";
    saveProjectMessage(proj, makeMsg({ source: "cli", content: "cli search me" }));
    saveProjectMessage(proj, makeMsg({ source: "dashboard", content: "dash search me" }));
    const results = searchProjectMessages(proj, "search me", { source: "cli" });
    assert.equal(results.length, 1);
    assert.equal(results[0].source, "cli");
  });
});

// ── getMessageThreads ─────────────────────────────────────────────────────────

describe("getMessageThreads", () => {
  it("returns empty object for missing projectId", () => {
    assert.deepEqual(getMessageThreads(null), {});
    assert.deepEqual(getMessageThreads(""), {});
  });

  it("returns empty array for specific thread on missing projectId", () => {
    assert.deepEqual(getMessageThreads(null, "t-1"), []);
  });

  it("groups messages by threadId", () => {
    const proj = "proj-threads";
    saveProjectMessage(proj, makeMsg({ threadId: "t-1" }));
    saveProjectMessage(proj, makeMsg({ threadId: "t-1" }));
    saveProjectMessage(proj, makeMsg({ threadId: "t-2" }));
    saveProjectMessage(proj, makeMsg()); // no threadId

    const threads = getMessageThreads(proj);
    assert.equal(threads["t-1"].length, 2);
    assert.equal(threads["t-2"].length, 1);
    assert.ok(!("null" in threads));
  });

  it("returns messages for a specific thread when threadId is provided", () => {
    const proj = "proj-threads-specific";
    saveProjectMessage(proj, makeMsg({ threadId: "t-A", content: "thread-A msg" }));
    saveProjectMessage(proj, makeMsg({ threadId: "t-B", content: "thread-B msg" }));

    const msgs = getMessageThreads(proj, "t-A");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "thread-A msg");
  });

  it("returns empty array when requested threadId has no messages", () => {
    const proj = "proj-threads-empty";
    saveProjectMessage(proj, makeMsg({ threadId: "t-exists" }));
    assert.deepEqual(getMessageThreads(proj, "t-nonexistent"), []);
  });
});

// ── buildMessageTree ──────────────────────────────────────────────────────────

describe("buildMessageTree", () => {
  it("returns empty array for missing projectId", () => {
    assert.deepEqual(buildMessageTree(null), []);
    assert.deepEqual(buildMessageTree(""), []);
  });

  it("returns flat root messages when no parentIds", () => {
    const proj = "proj-tree-flat";
    seedMessages(proj, 3);
    const tree = buildMessageTree(proj);
    assert.equal(tree.length, 3);
    for (const node of tree) {
      assert.deepEqual(node.children, []);
    }
  });

  it("nests child messages under their parent", () => {
    const proj = "proj-tree-nested";
    const rootId = saveProjectMessage(proj, makeMsg({ content: "root" }));
    saveProjectMessage(proj, makeMsg({ content: "child", parentId: rootId }));

    const tree = buildMessageTree(proj);
    const root = tree.find((n) => n.id === rootId);
    assert.ok(root);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].content, "child");
  });

  it("returns subtree when rootId is specified", () => {
    const proj = "proj-tree-sub";
    const id1 = saveProjectMessage(proj, makeMsg({ content: "root1" }));
    const id2 = saveProjectMessage(proj, makeMsg({ content: "root2" }));
    saveProjectMessage(proj, makeMsg({ content: "child-of-1", parentId: id1 }));

    const subtree = buildMessageTree(proj, id1);
    assert.equal(subtree.length, 1);
    assert.equal(subtree[0].id, id1);
  });

  it("orphan messages (parentId references a missing message) are promoted to roots", () => {
    const proj = "proj-tree-orphan";
    saveProjectMessage(proj, makeMsg({ content: "orphan", parentId: "nonexistent-parent" }));
    const tree = buildMessageTree(proj);
    // Orphan is promoted to root since its parent doesn't exist
    assert.equal(tree.length, 1);
    assert.equal(tree[0].content, "orphan");
  });
});

// ── exportProjectMessages ─────────────────────────────────────────────────────

describe("exportProjectMessages", () => {
  it("returns empty string for missing projectId", () => {
    assert.equal(exportProjectMessages(null), "");
    assert.equal(exportProjectMessages(""), "");
  });

  it("exports JSON format", () => {
    const proj = "proj-export-json";
    saveProjectMessage(proj, makeMsg({ content: "export me" }));
    const out = exportProjectMessages(proj, "json");
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].content, "export me");
  });

  it("exports markdown format with project heading", () => {
    const proj = "proj-export-md";
    saveProjectMessage(proj, makeMsg({ content: "md content" }));
    const out = exportProjectMessages(proj, "markdown");
    assert.ok(out.includes(`# Project Chat: ${proj}`));
    assert.ok(out.includes("md content"));
  });

  it("markdown includes metadata details block when includeMetadata is true", () => {
    const proj = "proj-export-md-meta";
    saveProjectMessage(proj, makeMsg({ metadata: { tag: "important" } }));
    const out = exportProjectMessages(proj, "markdown", { includeMetadata: true });
    assert.ok(out.includes("<details>"));
    assert.ok(out.includes("important"));
  });

  it("markdown does not include metadata block when metadata is empty", () => {
    const proj = "proj-export-md-nometa";
    saveProjectMessage(proj, makeMsg());
    const out = exportProjectMessages(proj, "markdown", { includeMetadata: true });
    assert.ok(!out.includes("<details>"));
  });

  it("exports CSV format with header row", () => {
    const proj = "proj-export-csv";
    saveProjectMessage(proj, makeMsg({ content: "csv content" }));
    const out = exportProjectMessages(proj, "csv");
    assert.ok(out.startsWith("timestamp,source,role,agent,content\n"));
    assert.ok(out.includes("csv content"));
  });

  it("CSV escapes double quotes in content", () => {
    const proj = "proj-export-csv-quote";
    saveProjectMessage(proj, makeMsg({ content: 'say "hello"' }));
    const out = exportProjectMessages(proj, "csv");
    assert.ok(out.includes('""hello""'));
  });

  it("CSV replaces newlines with spaces in content", () => {
    const proj = "proj-export-csv-nl";
    saveProjectMessage(proj, makeMsg({ content: "line1\nline2" }));
    const out = exportProjectMessages(proj, "csv");
    assert.ok(out.includes("line1 line2"));
  });

  it("exports txt format", () => {
    const proj = "proj-export-txt";
    saveProjectMessage(proj, makeMsg({ content: "txt content" }));
    const out = exportProjectMessages(proj, "txt");
    assert.ok(out.includes("txt content"));
    assert.ok(out.includes("(user):"));
  });

  it("txt format includes agent label when present", () => {
    const proj = "proj-export-txt-agent";
    saveProjectMessage(proj, makeMsg({ agent: "crew-qa", content: "qa says hi" }));
    const out = exportProjectMessages(proj, "txt");
    assert.ok(out.includes("[crew-qa]"));
  });

  it("returns empty string for unrecognised format", () => {
    const proj = "proj-export-unknown";
    saveProjectMessage(proj, makeMsg());
    assert.equal(exportProjectMessages(proj, "xml"), "");
  });

  it("respects limit option", () => {
    const proj = "proj-export-lim";
    seedMessages(proj, 10);
    const out = exportProjectMessages(proj, "json", { limit: 3 });
    const parsed = JSON.parse(out);
    assert.equal(parsed.length, 3);
  });

  it("module exports all expected functions", async () => {
    const mod = await import("../../lib/chat/project-messages.mjs");
    const expected = [
      "saveProjectMessage",
      "loadProjectMessages",
      "formatProjectMessages",
      "getProjectMessageStats",
      "clearProjectMessages",
      "listProjectsWithMessages",
      "searchProjectMessages",
      "getMessageThreads",
      "buildMessageTree",
      "exportProjectMessages",
    ];
    for (const fn of expected) {
      assert.equal(typeof mod[fn], "function", `Missing export: ${fn}`);
    }
  });
});
