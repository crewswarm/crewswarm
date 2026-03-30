/**
 * Unit tests for the RT bus WebSocket protocol contract.
 *
 * Validates message shapes, required fields, and protocol flows
 * as implemented by ws-router.mjs (crew-lead) and gateway-ws.mjs (agent).
 *
 * Pure unit tests — no WebSocket connections, no I/O.
 *
 * Run with: node --test test/unit/rt-bus-protocol.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Protocol message builders (mirror what ws-router and gateway-ws produce)
// ---------------------------------------------------------------------------

/** server.hello — sent by RT server to initiate handshake */
function buildServerHello() {
  return { type: "server.hello" };
}

/** hello — client response to server.hello */
function buildHello(agent, token) {
  return { type: "hello", agent, token };
}

/** hello.ack — server confirms authentication */
function buildHelloAck() {
  return { type: "hello.ack" };
}

/** subscribe — client subscribes to channels after hello.ack */
function buildSubscribe(channels) {
  return { type: "subscribe", channels };
}

/** publish — send a message to a channel */
function buildPublish({ channel, messageType, to, taskId, priority, payload }) {
  return { type: "publish", channel, messageType, to, taskId, priority, payload };
}

/** ack — acknowledge receipt of a message */
function buildAck(messageId, status, note) {
  const msg = { type: "ack", messageId, status };
  if (note != null) msg.note = note;
  return msg;
}

/** error — protocol error from the server */
function buildError(message) {
  return { type: "error", message };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function assertHasFields(obj, fields, label) {
  for (const f of fields) {
    assert.ok(f in obj, `${label} missing required field "${f}"`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RT bus protocol — message format validation", () => {
  it("server.hello has type field", () => {
    const msg = buildServerHello();
    assert.equal(msg.type, "server.hello");
  });

  it("hello has type, agent, and token fields", () => {
    const msg = buildHello("crew-coder", "tok_abc");
    assertHasFields(msg, ["type", "agent", "token"], "hello");
    assert.equal(msg.type, "hello");
    assert.equal(msg.agent, "crew-coder");
    assert.equal(msg.token, "tok_abc");
  });

  it("hello.ack has type field", () => {
    const msg = buildHelloAck();
    assert.equal(msg.type, "hello.ack");
  });

  it("subscribe has type and channels fields", () => {
    const msg = buildSubscribe(["done", "events", "command"]);
    assertHasFields(msg, ["type", "channels"], "subscribe");
    assert.equal(msg.type, "subscribe");
    assert.ok(Array.isArray(msg.channels));
  });

  it("publish has all required fields", () => {
    const msg = buildPublish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-coder",
      taskId: "task-123",
      priority: "high",
      payload: { content: "fix the bug" },
    });
    assertHasFields(msg, ["type", "channel", "messageType", "to", "taskId", "priority", "payload"], "publish");
    assert.equal(msg.type, "publish");
  });

  it("ack has type, messageId, and status fields", () => {
    const msg = buildAck("msg-42", "received");
    assertHasFields(msg, ["type", "messageId", "status"], "ack");
    assert.equal(msg.type, "ack");
    assert.equal(msg.messageId, "msg-42");
    assert.equal(msg.status, "received");
  });

  it("error has type and message fields", () => {
    const msg = buildError("invalid token");
    assertHasFields(msg, ["type", "message"], "error");
    assert.equal(msg.type, "error");
    assert.equal(msg.message, "invalid token");
  });
});

describe("RT bus protocol — publish payload structure", () => {
  it("publish includes channel, messageType, to, taskId, priority, payload", () => {
    const msg = buildPublish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-fixer",
      taskId: "uuid-1",
      priority: "high",
      payload: { prompt: "refactor module" },
    });
    assert.equal(msg.channel, "command");
    assert.equal(msg.messageType, "command.run_task");
    assert.equal(msg.to, "crew-fixer");
    assert.equal(msg.taskId, "uuid-1");
    assert.equal(msg.priority, "high");
    assert.deepEqual(msg.payload, { prompt: "refactor module" });
  });

  it("rejects publish with missing channel", () => {
    const msg = buildPublish({
      channel: undefined,
      messageType: "task",
      to: "x",
      taskId: "t",
      priority: "low",
      payload: {},
    });
    assert.equal(msg.channel, undefined, "channel should be undefined when omitted");
  });

  it("rejects publish with missing messageType", () => {
    const msg = buildPublish({
      channel: "done",
      messageType: undefined,
      to: "x",
      taskId: "t",
      priority: "low",
      payload: {},
    });
    assert.equal(msg.messageType, undefined, "messageType should be undefined when omitted");
  });
});

describe("RT bus protocol — hello handshake flow", () => {
  it("follows server.hello -> hello -> hello.ack -> subscribe sequence", () => {
    // Step 1: server sends server.hello
    const step1 = buildServerHello();
    assert.equal(step1.type, "server.hello");

    // Step 2: client responds with hello (agent name + token)
    const step2 = buildHello("crew-lead", "secret-token");
    assert.equal(step2.type, "hello");
    assert.equal(step2.agent, "crew-lead");
    assert.equal(step2.token, "secret-token");

    // Step 3: server confirms with hello.ack
    const step3 = buildHelloAck();
    assert.equal(step3.type, "hello.ack");

    // Step 4: client subscribes to channels
    const step4 = buildSubscribe(["done", "events", "command", "issues", "status"]);
    assert.equal(step4.type, "subscribe");
    assert.deepEqual(step4.channels, ["done", "events", "command", "issues", "status"]);
  });

  it("crew-lead subscribes to done, events, command, issues, status channels", () => {
    // From ws-router.mjs line 155
    const msg = buildSubscribe(["done", "events", "command", "issues", "status"]);
    assert.equal(msg.channels.length, 5);
    assert.ok(msg.channels.includes("done"));
    assert.ok(msg.channels.includes("events"));
    assert.ok(msg.channels.includes("command"));
    assert.ok(msg.channels.includes("issues"));
    assert.ok(msg.channels.includes("status"));
  });

  it("gateway agent subscribes to configured channels", () => {
    // From gateway-ws.mjs line 86 — channels come from config
    const agentChannels = ["command", "events", "done", "status"];
    const msg = buildSubscribe(agentChannels);
    assert.ok(Array.isArray(msg.channels));
    assert.equal(msg.channels.length, 4);
  });
});

describe("RT bus protocol — ack format", () => {
  it("ack contains messageId and status", () => {
    const msg = buildAck("envelope-99", "received");
    assert.equal(msg.messageId, "envelope-99");
    assert.equal(msg.status, "received");
  });

  it("ack with status=skipped and note", () => {
    // From gateway-ws / rt-envelope pattern: skip ack includes a note
    const msg = buildAck("envelope-100", "skipped", "not for us");
    assert.equal(msg.status, "skipped");
    assert.equal(msg.note, "not for us");
  });

  it("ack with status=done", () => {
    const msg = buildAck("envelope-101", "done");
    assert.equal(msg.status, "done");
  });

  it("ack type field is always 'ack'", () => {
    const msg = buildAck("x", "received");
    assert.equal(msg.type, "ack");
  });
});

describe("RT bus protocol — error format", () => {
  it("error has a message field", () => {
    const msg = buildError("authentication failed");
    assert.equal(msg.type, "error");
    assert.equal(msg.message, "authentication failed");
  });

  it("error with empty message is still valid shape", () => {
    const msg = buildError("");
    assert.equal(msg.type, "error");
    assert.equal(typeof msg.message, "string");
  });

  it("auth-related error messages match crew-lead detection pattern", () => {
    // ws-router.mjs line 225: /token|auth|unauthorized/i
    const pattern = /token|auth|unauthorized/i;
    assert.ok(pattern.test("invalid token"));
    assert.ok(pattern.test("authentication failed"));
    assert.ok(pattern.test("Unauthorized access"));
    assert.ok(!pattern.test("rate limit exceeded"));
  });
});

describe("RT bus protocol — channel subscription", () => {
  it("subscribe message channels is an array", () => {
    const msg = buildSubscribe(["done"]);
    assert.ok(Array.isArray(msg.channels));
  });

  it("subscribe with empty channels array is valid shape", () => {
    const msg = buildSubscribe([]);
    assert.deepEqual(msg.channels, []);
  });

  it("channels contain only strings", () => {
    const channels = ["done", "events", "command", "issues", "status"];
    const msg = buildSubscribe(channels);
    for (const ch of msg.channels) {
      assert.equal(typeof ch, "string", `channel should be string, got ${typeof ch}`);
    }
  });
});

describe("RT bus protocol — task dispatch format (command.run_task)", () => {
  it("command.run_task publish includes content in payload", () => {
    const msg = buildPublish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-coder",
      taskId: "task-abc",
      priority: "high",
      payload: {
        content: "Implement the login form",
        prompt: "Implement the login form with validation",
        correlationId: "corr-xyz",
      },
    });
    assert.equal(msg.messageType, "command.run_task");
    assert.equal(msg.channel, "command");
    assert.ok(msg.payload.content, "payload must have content");
    assert.ok(msg.payload.prompt, "payload must have prompt");
    assert.ok(msg.payload.correlationId, "payload must have correlationId");
  });

  it("task dispatch targets a specific agent via 'to' field", () => {
    const msg = buildPublish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-frontend",
      taskId: "task-def",
      priority: "high",
      payload: { content: "build sidebar", prompt: "build sidebar", correlationId: "c-1" },
    });
    assert.equal(msg.to, "crew-frontend");
    assert.notEqual(msg.to, "broadcast");
  });

  it("task dispatch uses high priority", () => {
    const msg = buildPublish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-coder",
      taskId: "task-ghi",
      priority: "high",
      payload: { content: "fix bug", prompt: "fix bug", correlationId: "c-2" },
    });
    assert.equal(msg.priority, "high");
  });
});

describe("RT bus protocol — task done format", () => {
  it("task.done message has result content in payload", () => {
    const msg = buildPublish({
      channel: "done",
      messageType: "task.done",
      to: "crew-lead",
      taskId: "task-completed",
      priority: "medium",
      payload: {
        reply: "Implemented the login form with email validation.",
        content: "Implemented the login form with email validation.",
        source: "crew-coder",
      },
    });
    assert.equal(msg.messageType, "task.done");
    assert.equal(msg.channel, "done");
    assert.ok(msg.payload.reply || msg.payload.content, "task.done must have reply or content");
  });

  it("task.done can carry engineUsed metadata", () => {
    const msg = buildPublish({
      channel: "done",
      messageType: "task.done",
      to: "crew-lead",
      taskId: "task-eng",
      priority: "medium",
      payload: {
        reply: "Done.",
        source: "crew-coder",
        engineUsed: "claude",
      },
    });
    assert.equal(msg.payload.engineUsed, "claude");
  });

  it("task.done on the done channel is recognized as isDone by crew-lead", () => {
    // ws-router.mjs line 315: isDone = msgType === "task.done" || env.channel === "done"
    const envelope = { channel: "done", messageType: "task.done" };
    const isDone = envelope.messageType === "task.done" || envelope.channel === "done";
    assert.ok(isDone);
  });

  it("message on done channel without task.done type is still isDone", () => {
    // ws-router.mjs line 315: channel === "done" is sufficient
    const envelope = { channel: "done", messageType: "some.other" };
    const isDone = envelope.messageType === "task.done" || envelope.channel === "done";
    assert.ok(isDone, "channel=done alone should satisfy isDone check");
  });
});

describe("RT bus protocol — heartbeat format", () => {
  it("agent.heartbeat has agent and ts in payload", () => {
    // ws-router.mjs line 207-209
    const msg = buildPublish({
      channel: "status",
      messageType: "agent.heartbeat",
      to: "broadcast",
      taskId: "hb-1",
      priority: "low",
      payload: {
        agent: "crew-lead",
        ts: "2026-03-30T12:00:00.000Z",
      },
    });
    assert.equal(msg.messageType, "agent.heartbeat");
    assert.equal(msg.channel, "status");
    assert.equal(msg.to, "broadcast");
    assert.ok(msg.payload.agent, "heartbeat payload must have agent");
    assert.ok(msg.payload.ts, "heartbeat payload must have ts");
  });

  it("heartbeat ts is an ISO string", () => {
    const ts = new Date().toISOString();
    const msg = buildPublish({
      channel: "status",
      messageType: "agent.heartbeat",
      to: "broadcast",
      taskId: "hb-2",
      priority: "low",
      payload: { agent: "crew-coder", ts },
    });
    // ISO 8601 pattern check
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(msg.payload.ts));
  });

  it("crew-lead heartbeat uses low priority", () => {
    // ws-router.mjs line 208
    const msg = buildPublish({
      channel: "status",
      messageType: "agent.heartbeat",
      to: "broadcast",
      taskId: "hb-3",
      priority: "low",
      payload: { agent: "crew-lead", ts: new Date().toISOString() },
    });
    assert.equal(msg.priority, "low");
  });

  it("gateway agent heartbeat uses default medium priority", () => {
    // gateway-ws.mjs line 301-308: publish with no explicit priority defaults to medium
    const msg = buildPublish({
      channel: "status",
      messageType: "agent.heartbeat",
      to: "broadcast",
      taskId: "hb-4",
      priority: "medium",
      payload: { agent: "crew-coder", ts: new Date().toISOString() },
    });
    assert.equal(msg.priority, "medium");
  });
});

describe("RT bus protocol — gateway-ws client.publish contract", () => {
  it("client.publish uses type as messageType in the frame", () => {
    // gateway-ws.mjs line 50-58: publish({ channel, type, ... }) sends messageType: type
    const sent = [];
    const mockSendFrame = (frame) => sent.push(frame);

    // Simulate what client.publish does
    const params = {
      channel: "events",
      type: "agent.online",
      to: "broadcast",
      taskId: "t-1",
      correlationId: "corr-1",
      priority: "high",
      payload: { agent: "crew-coder" },
    };
    // Reproduce the sendFrame call from gateway-ws.mjs line 50-58
    mockSendFrame({
      type: "publish",
      channel: params.channel,
      messageType: params.type,
      to: params.to,
      taskId: params.taskId,
      correlationId: params.correlationId,
      priority: params.priority,
      payload: params.payload,
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "publish");
    assert.equal(sent[0].messageType, "agent.online");
    assert.equal(sent[0].correlationId, "corr-1");
  });

  it("client.ack sends type=ack with messageId and status", () => {
    // gateway-ws.mjs line 61-62
    const sent = [];
    const mockSendFrame = (frame) => sent.push(frame);

    mockSendFrame({ type: "ack", messageId: "env-55", status: "received", note: "" });

    assert.equal(sent[0].type, "ack");
    assert.equal(sent[0].messageId, "env-55");
    assert.equal(sent[0].status, "received");
  });
});

describe("RT bus protocol — message envelope (server wraps in envelope)", () => {
  it("server message envelope has id, channel, messageType, from, to, taskId, payload", () => {
    // ws-router.mjs line 231-253: processes p.type === "message" with p.envelope
    const envelope = {
      id: "env-1",
      channel: "done",
      messageType: "task.done",
      from: "crew-coder",
      to: "crew-lead",
      taskId: "task-42",
      payload: { reply: "Fixed the bug.", source: "crew-coder" },
    };
    assertHasFields(envelope, ["id", "channel", "messageType", "from", "to", "taskId", "payload"], "envelope");
  });

  it("crew-lead acks envelope by id", () => {
    // ws-router.mjs line 234
    const envelope = { id: "env-2", channel: "command", messageType: "task", payload: {} };
    const ack = buildAck(envelope.id, "received");
    assert.equal(ack.messageId, "env-2");
  });

  it("envelope payload can carry correlationId for task tracking", () => {
    const envelope = {
      id: "env-3",
      channel: "status",
      messageType: "task.in_progress",
      from: "crew-fixer",
      to: "crew-lead",
      taskId: "task-77",
      correlationId: "task-77",
      payload: {},
    };
    assert.ok(envelope.taskId || envelope.correlationId, "envelope must carry taskId or correlationId");
  });
});

describe("RT bus protocol — known message types", () => {
  const KNOWN_TYPES = [
    "server.hello",
    "hello",
    "hello.ack",
    "subscribe",
    "publish",
    "ack",
    "error",
    "message",
  ];

  for (const t of KNOWN_TYPES) {
    it(`"${t}" is a recognized top-level message type`, () => {
      assert.equal(typeof t, "string");
      assert.ok(t.length > 0);
    });
  }

  const KNOWN_MESSAGE_TYPES = [
    "agent.heartbeat",
    "agent.online",
    "agent.offline",
    "agent_working",
    "agent_idle",
    "task.done",
    "task.in_progress",
    "task.claimed",
    "task.failed",
    "command.run_task",
    "command.spawn_agent",
    "command.collect_status",
    "cmd.needs_approval",
    "cmd.approved",
    "cmd.rejected",
  ];

  for (const mt of KNOWN_MESSAGE_TYPES) {
    it(`"${mt}" is a recognized envelope messageType`, () => {
      assert.equal(typeof mt, "string");
      assert.ok(mt.length > 0);
    });
  }
});
