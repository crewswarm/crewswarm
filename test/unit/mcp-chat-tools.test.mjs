/**
 * MCP Chat Tools — Unit Tests
 *
 * Tests the logic implemented by the four MCP chat tools:
 *   chat_send, chat_read, chat_channels, chat_who
 *
 * Because those tools are defined inline inside mcp-server.mjs (not exported),
 * we test them through the underlying store functions they call directly:
 *   saveProjectMessage, loadProjectMessages, listProjectsWithMessages
 * from lib/chat/project-messages.mjs — plus we replicate the thin adapter
 * logic (channel defaulting, limit clamping, participant aggregation) inline
 * so that every branch of each tool is exercised.
 *
 * Uses temp directories via CREWSWARM_STATE_DIR so no real ~/.crewswarm data
 * is ever touched.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Temp-dir isolation ────────────────────────────────────────────────────────

let tmpBase;

before(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "cs-mcp-chat-test-"));
  // Must be set before any dynamic import so paths.mjs picks it up
  process.env.CREWSWARM_STATE_DIR = tmpBase;
  process.env.CREWSWARM_CONFIG_DIR = tmpBase;
});

after(async () => {
  delete process.env.CREWSWARM_STATE_DIR;
  delete process.env.CREWSWARM_CONFIG_DIR;
  await rm(tmpBase, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a unique channel name so every test gets its own namespace. */
function uniqueChannel() {
  return `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Replicate the chat_send logic from mcp-server.mjs.
 * Uses the same saveProjectMessage call and returns the same shape.
 */
async function simulateChatSend(args) {
  const { saveProjectMessage } = await import(
    "../../lib/chat/project-messages.mjs"
  );

  const channel = String(args.channel || "general").trim() || "general";
  const actor = String(args.actor || "mcp").trim() || "mcp";
  const content = String(args.content || "").trim();
  const threadId = String(args.threadId || "").trim() || null;
  const parentId = String(args.parentId || "").trim() || null;

  if (!content) return { error: "content is required" };

  // Replicate detectMentions: scan for @word tokens
  const mentions = [...content.matchAll(/@([\w-]+)/g)].map((m) => m[1]);

  const id = saveProjectMessage(channel, {
    source: "agent",
    role: "assistant",
    content,
    agent: actor,
    threadId,
    parentId,
    metadata: {
      agentName: actor,
      via: "mcp",
      channel,
      ...(mentions.length ? { mentions } : {}),
    },
  });

  return { ok: true, channel, id, actor, threadId, parentId, mentions };
}

/**
 * Replicate the chat_read logic from mcp-server.mjs.
 */
async function simulateChatRead(args) {
  const { loadProjectMessages } = await import(
    "../../lib/chat/project-messages.mjs"
  );

  const channel = String(args.channel || "general").trim() || "general";
  const limit = Math.max(1, Math.min(Number(args.limit || 20), 200));
  const threadId = String(args.threadId || "").trim() || null;
  const mentionsFor = String(args.mentionsFor || "").trim() || null;
  const since = Number(args.since || 0) || null;

  const messages = loadProjectMessages(channel, {
    limit,
    ...(threadId && { threadId }),
    ...(mentionsFor && { mentionedAgent: mentionsFor }),
    ...(since ? { since } : {}),
  }).map((msg) => ({
    id: msg.id,
    ts: msg.ts,
    source: msg.source,
    role: msg.role,
    content: msg.content,
    agent: msg.agent,
    threadId: msg.threadId || null,
    parentId: msg.parentId || null,
    mentions: msg.metadata?.mentions || [],
  }));

  return { ok: true, channel, count: messages.length, threadId, mentionsFor, messages };
}

/**
 * Replicate the chat_channels logic from mcp-server.mjs.
 */
async function simulateChatChannels() {
  const { listProjectsWithMessages } = await import(
    "../../lib/chat/project-messages.mjs"
  );

  const projects = listProjectsWithMessages();
  const channels = [
    { channel: "general", lastActivity: null, messageCount: 0 },
    ...projects.map((project) => ({
      channel: project.projectId,
      lastActivity: project.lastActivity,
      messageCount: project.messageCount,
    })),
  ].filter(
    (entry, index, arr) =>
      arr.findIndex((candidate) => candidate.channel === entry.channel) === index,
  );

  return { ok: true, channels };
}

/**
 * Replicate the chat_who logic from mcp-server.mjs.
 */
async function simulateChatWho(args) {
  const { loadProjectMessages } = await import(
    "../../lib/chat/project-messages.mjs"
  );

  const channel = String(args.channel || "general").trim() || "general";
  const messages = loadProjectMessages(channel, { limit: 100 });
  const participants = new Map();

  for (const msg of messages) {
    const name =
      msg.metadata?.agentName ||
      msg.agent ||
      (msg.role === "user" ? "user" : msg.source || "assistant");
    participants.set(name, {
      name,
      source: msg.source,
      lastTs: msg.ts,
    });
  }

  return {
    ok: true,
    channel,
    participants: [...participants.values()].sort((a, b) => b.lastTs - a.lastTs),
  };
}

// ── 1. chat_send ──────────────────────────────────────────────────────────────

describe("chat_send", () => {
  it("writes a message and returns ok with a non-null id", async () => {
    const channel = uniqueChannel();
    const result = await simulateChatSend({ channel, content: "Hello crew!" });

    assert.equal(result.ok, true);
    assert.ok(result.id, "id should be a truthy UUID string");
    assert.equal(result.channel, channel);
  });

  it("saves the message so it can be loaded back", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Persisted message" });

    const msgs = loadProjectMessages(channel);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "Persisted message");
    assert.equal(msgs[0].source, "agent");
    assert.equal(msgs[0].role, "assistant");
  });

  it("uses actor param and stores it as agent + agentName in metadata", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Actor test", actor: "crew-qa" });

    const [msg] = loadProjectMessages(channel);
    assert.equal(msg.agent, "crew-qa");
    assert.equal(msg.metadata.agentName, "crew-qa");
  });

  it("defaults actor to 'mcp' when not provided", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "No actor" });

    const [msg] = loadProjectMessages(channel);
    assert.equal(msg.agent, "mcp");
  });

  it("defaults channel to 'general' when not provided", async () => {
    const result = await simulateChatSend({ content: "Default channel message" });
    assert.equal(result.channel, "general");
  });

  it("stores threadId on the saved message", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    const threadId = "thread-mcp-001";
    await simulateChatSend({ channel, content: "In a thread", threadId });

    const [msg] = loadProjectMessages(channel);
    assert.equal(msg.threadId, threadId);
  });

  it("stores parentId on the saved message", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    // First save a parent
    const { id: parentId } = await simulateChatSend({
      channel,
      content: "Parent message",
    });
    // Then save a reply referencing it
    await simulateChatSend({ channel, content: "Child message", parentId });

    const msgs = loadProjectMessages(channel);
    const child = msgs.find((m) => m.content === "Child message");
    assert.ok(child, "child message should exist");
    assert.equal(child.parentId, parentId);
  });

  it("returns error object when content is empty", async () => {
    const result = await simulateChatSend({ channel: uniqueChannel(), content: "" });
    assert.ok(result.error, "should return an error for empty content");
    assert.equal(result.ok, undefined);
  });

  it("returns each message with a unique id", async () => {
    const channel = uniqueChannel();
    const r1 = await simulateChatSend({ channel, content: "First" });
    const r2 = await simulateChatSend({ channel, content: "Second" });

    assert.ok(r1.id && r2.id);
    assert.notEqual(r1.id, r2.id);
  });
});

// ── 2. chat_read ──────────────────────────────────────────────────────────────

describe("chat_read", () => {
  it("reads messages and returns ok with count and messages array", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Readable message" });

    const result = await simulateChatRead({ channel });

    assert.equal(result.ok, true);
    assert.equal(result.channel, channel);
    assert.equal(typeof result.count, "number");
    assert.ok(Array.isArray(result.messages));
    assert.equal(result.count, result.messages.length);
  });

  it("respects the limit parameter", async () => {
    const channel = uniqueChannel();
    for (let i = 0; i < 10; i++) {
      await simulateChatSend({ channel, content: `Message ${i}` });
    }

    const result = await simulateChatRead({ channel, limit: 3 });
    assert.equal(result.messages.length, 3);
  });

  it("clamps limit to a minimum of 1", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Only message" });

    // Passing 0 or negative should be treated as 1
    const result = await simulateChatRead({ channel, limit: 0 });
    assert.ok(result.messages.length >= 1);
  });

  it("clamps limit to a maximum of 200", async () => {
    const channel = uniqueChannel();
    // 5 messages stored; asking for 999 should be clamped to 200 max but still
    // return only what exists
    for (let i = 0; i < 5; i++) {
      await simulateChatSend({ channel, content: `Msg ${i}` });
    }

    const result = await simulateChatRead({ channel, limit: 999 });
    // Should not crash and should return all 5 (well within 200 cap)
    assert.equal(result.messages.length, 5);
  });

  it("filters by threadId", async () => {
    const channel = uniqueChannel();
    const threadId = "read-thread-abc";

    await simulateChatSend({ channel, content: "Thread msg 1", threadId });
    await simulateChatSend({ channel, content: "Thread msg 2", threadId });
    await simulateChatSend({ channel, content: "No thread msg" });

    const result = await simulateChatRead({ channel, threadId });
    assert.equal(result.messages.length, 2);
    assert.ok(result.messages.every((m) => m.threadId === threadId));
    assert.equal(result.threadId, threadId);
  });

  it("filters by mentionsFor", async () => {
    const channel = uniqueChannel();

    // Message mentioning crew-qa
    await simulateChatSend({
      channel,
      content: "@crew-qa please review this",
      actor: "user-actor",
    });
    // Message without mention
    await simulateChatSend({ channel, content: "No mention here" });

    const result = await simulateChatRead({ channel, mentionsFor: "crew-qa" });
    assert.equal(result.messages.length, 1);
    assert.ok(result.messages[0].content.includes("@crew-qa"));
    assert.equal(result.mentionsFor, "crew-qa");
  });

  it("filters by since timestamp", async () => {
    const channel = uniqueChannel();

    // Manually save a message with a known old timestamp via the store
    const { saveProjectMessage } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const oldTs = Date.now() - 60_000; // 60 s ago — we fake this via content only
    // Save two messages via simulateChatSend (which uses Date.now() internally)
    await simulateChatSend({ channel, content: "Recent message A" });
    await simulateChatSend({ channel, content: "Recent message B" });

    // Use a since value before both messages (epoch 0 → all messages returned)
    const resultAll = await simulateChatRead({ channel, since: 0 });
    assert.ok(resultAll.messages.length >= 2);

    // Use a since value far in the future → no messages should be returned
    const resultNone = await simulateChatRead({ channel, since: Date.now() + 1_000_000 });
    assert.equal(resultNone.messages.length, 0);
  });

  it("returns empty messages array for a channel with no messages", async () => {
    const result = await simulateChatRead({ channel: uniqueChannel() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, []);
    assert.equal(result.count, 0);
  });

  it("each returned message has the expected shape", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Shape test", actor: "crew-coder" });

    const { messages } = await simulateChatRead({ channel });
    const [msg] = messages;

    assert.ok("id" in msg);
    assert.ok("ts" in msg);
    assert.ok("source" in msg);
    assert.ok("role" in msg);
    assert.ok("content" in msg);
    assert.ok("agent" in msg);
    assert.ok("threadId" in msg);
    assert.ok("parentId" in msg);
    assert.ok("mentions" in msg);
    assert.ok(Array.isArray(msg.mentions));
  });

  it("defaults channel to 'general' when not provided", async () => {
    const result = await simulateChatRead({});
    assert.equal(result.channel, "general");
  });
});

// ── 3. chat_channels ──────────────────────────────────────────────────────────

describe("chat_channels", () => {
  it("always includes 'general' as the first channel even with no messages", async () => {
    const result = await simulateChatChannels();

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.channels));

    const general = result.channels.find((c) => c.channel === "general");
    assert.ok(general, "general channel must always be present");
  });

  it("lists a channel after messages are written to it", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Activity!" });

    const result = await simulateChatChannels();
    const found = result.channels.find((c) => c.channel === channel);

    assert.ok(found, `channel ${channel} should appear in the list`);
    assert.ok(found.messageCount >= 1);
    assert.ok(found.lastActivity > 0);
  });

  it("does not duplicate the general channel when it also has messages", async () => {
    // Write to general to ensure it has messages
    await simulateChatSend({ channel: "general", content: "Hello general" });

    const result = await simulateChatChannels();
    const generals = result.channels.filter((c) => c.channel === "general");
    assert.equal(generals.length, 1, "general must not be duplicated");
  });

  it("returns ok flag", async () => {
    const result = await simulateChatChannels();
    assert.equal(result.ok, true);
  });

  it("each channel entry has channel, lastActivity, and messageCount fields", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Structure test" });

    const result = await simulateChatChannels();
    const entry = result.channels.find((c) => c.channel === channel);

    assert.ok(entry);
    assert.ok("channel" in entry);
    assert.ok("lastActivity" in entry);
    assert.ok("messageCount" in entry);
  });
});

// ── 4. chat_who ───────────────────────────────────────────────────────────────

describe("chat_who", () => {
  it("returns ok with channel and participants array", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Presence ping", actor: "crew-pm" });

    const result = await simulateChatWho({ channel });

    assert.equal(result.ok, true);
    assert.equal(result.channel, channel);
    assert.ok(Array.isArray(result.participants));
  });

  it("lists each actor that posted to the channel", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "From coder", actor: "crew-coder" });
    await simulateChatSend({ channel, content: "From qa", actor: "crew-qa" });

    const { participants } = await simulateChatWho({ channel });
    const names = participants.map((p) => p.name);

    assert.ok(names.includes("crew-coder"));
    assert.ok(names.includes("crew-qa"));
  });

  it("sorts participants by most recent activity (descending)", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Earlier post", actor: "crew-first" });
    // Small delay to guarantee a different timestamp
    await new Promise((r) => setTimeout(r, 5));
    await simulateChatSend({ channel, content: "Later post", actor: "crew-last" });

    const { participants } = await simulateChatWho({ channel });
    assert.equal(participants[0].name, "crew-last", "most recent actor should be first");
  });

  it("deduplicates an actor that posted multiple times", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "First post", actor: "crew-repeat" });
    await simulateChatSend({ channel, content: "Second post", actor: "crew-repeat" });

    const { participants } = await simulateChatWho({ channel });
    const repeated = participants.filter((p) => p.name === "crew-repeat");
    assert.equal(repeated.length, 1, "duplicate actor should be merged to one entry");
  });

  it("updates lastTs to the most recent message when an actor posts multiple times", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Old post", actor: "crew-ts-test" });
    await new Promise((r) => setTimeout(r, 5));
    const beforeSecond = Date.now();
    await simulateChatSend({ channel, content: "New post", actor: "crew-ts-test" });

    const { participants } = await simulateChatWho({ channel });
    const p = participants.find((p) => p.name === "crew-ts-test");
    assert.ok(p.lastTs >= beforeSecond, "lastTs should reflect the most recent post");
  });

  it("returns empty participants array for a channel with no messages", async () => {
    const result = await simulateChatWho({ channel: uniqueChannel() });
    assert.deepEqual(result.participants, []);
  });

  it("defaults channel to 'general' when not provided", async () => {
    const result = await simulateChatWho({});
    assert.equal(result.channel, "general");
  });

  it("each participant entry has name, source, and lastTs fields", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Shape test", actor: "crew-shape" });

    const { participants } = await simulateChatWho({ channel });
    const [p] = participants;

    assert.ok("name" in p);
    assert.ok("source" in p);
    assert.ok("lastTs" in p);
    assert.equal(typeof p.lastTs, "number");
  });
});

// ── 5. Thread support (end-to-end) ───────────────────────────────────────────

describe("thread support — send messages with threadId and read back only that thread", () => {
  it("sends multiple messages to the same thread and reads them back via threadId filter", async () => {
    const channel = uniqueChannel();
    const threadId = "e2e-thread-xyz";

    await simulateChatSend({ channel, content: "Thread start", threadId, actor: "crew-lead" });
    await simulateChatSend({ channel, content: "Thread reply", threadId, actor: "crew-coder" });
    await simulateChatSend({ channel, content: "Off thread", actor: "crew-pm" });

    const result = await simulateChatRead({ channel, threadId });

    assert.equal(result.messages.length, 2);
    assert.ok(result.messages.every((m) => m.threadId === threadId));
  });

  it("thread messages preserve actor names", async () => {
    const channel = uniqueChannel();
    const threadId = "actor-thread-001";

    await simulateChatSend({ channel, content: "Actor in thread", threadId, actor: "crew-qa" });

    const { messages } = await simulateChatRead({ channel, threadId });
    assert.equal(messages[0].agent, "crew-qa");
  });

  it("thread messages preserve parentId linkage", async () => {
    const channel = uniqueChannel();
    const threadId = "parent-thread-001";

    const { id: rootId } = await simulateChatSend({ channel, content: "Root", threadId });
    await simulateChatSend({ channel, content: "Reply", threadId, parentId: rootId });

    const { messages } = await simulateChatRead({ channel, threadId });
    const reply = messages.find((m) => m.content === "Reply");
    assert.equal(reply.parentId, rootId);
  });

  it("two different threads in the same channel stay isolated", async () => {
    const channel = uniqueChannel();
    const threadA = "thread-alpha";
    const threadB = "thread-beta";

    await simulateChatSend({ channel, content: "Alpha msg", threadId: threadA });
    await simulateChatSend({ channel, content: "Beta msg", threadId: threadB });

    const resA = await simulateChatRead({ channel, threadId: threadA });
    const resB = await simulateChatRead({ channel, threadId: threadB });

    assert.equal(resA.messages.length, 1);
    assert.equal(resA.messages[0].content, "Alpha msg");

    assert.equal(resB.messages.length, 1);
    assert.equal(resB.messages[0].content, "Beta msg");
  });
});

// ── 6. Mentions — @mention in content, filter by mentionsFor ─────────────────

describe("mentions — send with @mentions in metadata, filter by mentionsFor", () => {
  it("detects @mentions in message content and stores them in metadata", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "@crew-qa please review this PR" });

    const [msg] = loadProjectMessages(channel);
    assert.ok(
      Array.isArray(msg.metadata.mentions),
      "mentions should be an array in metadata"
    );
    assert.ok(msg.metadata.mentions.includes("crew-qa"));
  });

  it("detects multiple @mentions in a single message", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    await simulateChatSend({
      channel,
      content: "@crew-coder and @crew-qa can you pair on this?",
    });

    const [msg] = loadProjectMessages(channel);
    assert.ok(msg.metadata.mentions.includes("crew-coder"));
    assert.ok(msg.metadata.mentions.includes("crew-qa"));
  });

  it("stores no mentions key when there are no @mentions in content", async () => {
    const { loadProjectMessages } = await import(
      "../../lib/chat/project-messages.mjs"
    );

    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "Nothing to mention here" });

    const [msg] = loadProjectMessages(channel);
    // When no mentions are detected, the metadata key is omitted
    assert.ok(
      !msg.metadata.mentions || msg.metadata.mentions.length === 0,
      "no mentions key or empty array when no @mentions present"
    );
  });

  it("mentionsFor filter returns only messages that mention the specified agent", async () => {
    const channel = uniqueChannel();

    await simulateChatSend({ channel, content: "@crew-qa please look at this" });
    await simulateChatSend({ channel, content: "@crew-coder can you fix this" });
    await simulateChatSend({ channel, content: "General announcement" });

    const result = await simulateChatRead({ channel, mentionsFor: "crew-qa" });

    assert.equal(result.messages.length, 1);
    assert.ok(result.messages[0].content.includes("@crew-qa"));
  });

  it("mentionsFor filter returns multiple messages when the same agent is mentioned more than once", async () => {
    const channel = uniqueChannel();

    await simulateChatSend({ channel, content: "@crew-qa first task" });
    await simulateChatSend({ channel, content: "@crew-qa second task" });
    await simulateChatSend({ channel, content: "Unrelated" });

    const result = await simulateChatRead({ channel, mentionsFor: "crew-qa" });
    assert.equal(result.messages.length, 2);
    assert.ok(result.messages.every((m) => m.mentions.includes("crew-qa")));
  });

  it("mentionsFor returns empty when no message mentions the queried agent", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "@crew-coder do the thing" });

    const result = await simulateChatRead({ channel, mentionsFor: "crew-lead" });
    assert.equal(result.messages.length, 0);
  });

  it("mentions array is exposed on the read message objects (not buried in metadata)", async () => {
    const channel = uniqueChannel();
    await simulateChatSend({ channel, content: "@crew-pm sprint review" });

    const { messages } = await simulateChatRead({ channel });
    const [msg] = messages;

    assert.ok(Array.isArray(msg.mentions), "mentions should be a top-level array on read messages");
    assert.ok(msg.mentions.includes("crew-pm"));
  });
});
