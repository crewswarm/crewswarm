/**
 * Unit tests for lib/bridges/gateway-ws.mjs
 *
 * The module exports a single factory function initGatewayWs(deps) that returns
 * { createRealtimeClient, createBridge, runRealtimeDaemon }.
 *
 * We test by injecting a fake WebSocket class and verifying frame sequences,
 * client methods, and error handling — no real network calls.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { initGatewayWs } from "../../lib/bridges/gateway-ws.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  readyState = FakeWebSocket.OPEN;
  sent = [];

  constructor() {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function makeDeps(overrides = {}) {
  const telemetryLog = [];
  return {
    WebSocket: FakeWebSocket,
    crypto: {
      randomUUID: () => "uuid-1234",
      sign: () => Buffer.from("sig"),
      createPrivateKey: (pem) => pem,
    },
    CREWSWARM_RT_URL: "ws://localhost:9999",
    CREWSWARM_RT_TLS_INSECURE: false,
    CREWSWARM_RT_TOKEN: "tok-test",
    GATEWAY_URL: "ws://localhost:8888",
    PROTOCOL_VERSION: 1,
    REQUEST_TIMEOUT_MS: 5000,
    CHAT_TIMEOUT_MS: 5000,
    CREWSWARM_RT_AGENT: "test-agent",
    CREWSWARM_RT_CHANNELS: ["events", "status"],
    CREWSWARM_RT_RECONNECT_MS: 100,
    telemetry: (name, data) => telemetryLog.push({ name, data }),
    progress: () => {},
    parseJsonSafe: (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } },
    parseTextContent: (content) => typeof content === "string" ? content : content?.text || "",
    withRetry: (fn) => fn(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    b64url: (buf) => Buffer.from(buf).toString("base64url"),
    deriveRaw: (pem) => Buffer.from("pubkey"),
    syncOpenCodePermissions: () => {},
    handleRealtimeEnvelope: () => {},
    setRtClient: () => {},
    setRtClientForRunners: () => {},
    _telemetryLog: telemetryLog,
    ...overrides,
  };
}

// ── createRealtimeClient ─────────────────────────────────────────────────────

describe("createRealtimeClient", () => {
  beforeEach(() => { FakeWebSocket.instances = []; });

  it("resolves client after server.hello + hello.ack handshake", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({
      onEnvelope: () => {},
    });

    const ws = FakeWebSocket.instances[0];
    // Simulate server hello
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    // Should have sent hello frame
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].type, "hello");
    assert.equal(ws.sent[0].agent, "test-agent");

    // Simulate hello.ack
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    const client = await clientPromise;

    // Should have sent subscribe frame
    assert.equal(ws.sent[1].type, "subscribe");
    assert.deepEqual(ws.sent[1].channels, ["events", "status"]);
    assert.ok(client.isReady());
  });

  it("rejects on error before ready", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "error", message: "auth failed" })));

    await assert.rejects(clientPromise, /auth failed/);
  });

  it("rejects on close before ready", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("close");

    await assert.rejects(clientPromise, /closed before ready/);
  });

  it("rejects on socket error before ready", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("error", new Error("ECONNREFUSED"));

    await assert.rejects(clientPromise, /ECONNREFUSED/);
  });

  it("client.publish sends correct frame", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    const client = await clientPromise;

    client.publish({ channel: "events", type: "test.ping", payload: { foo: 1 } });
    const frame = ws.sent[ws.sent.length - 1];
    assert.equal(frame.type, "publish");
    assert.equal(frame.channel, "events");
    assert.equal(frame.messageType, "test.ping");
    assert.deepEqual(frame.payload, { foo: 1 });
  });

  it("client.publish throws when socket is not open", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    const client = await clientPromise;

    ws.readyState = 3; // CLOSED
    assert.throws(() => {
      client.publish({ channel: "events", type: "test.ping" });
    }, /not open/);
  });

  it("client.ack sends ack frame", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    const client = await clientPromise;

    client.ack({ messageId: "msg-1" });
    const frame = ws.sent[ws.sent.length - 1];
    assert.equal(frame.type, "ack");
    assert.equal(frame.messageId, "msg-1");
    assert.equal(frame.status, "received");
  });

  it("client.close closes websocket", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    const client = await clientPromise;

    client.close();
    assert.equal(ws.readyState, 3);
  });

  it("calls onEnvelope for message-type frames", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);
    const received = [];

    const clientPromise = createRealtimeClient({
      onEnvelope: (env) => received.push(env),
    });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    await clientPromise;

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "message",
      envelope: { task: "build feature X" },
    })));

    // Give async handler time to run
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(received.length, 1);
    assert.equal(received[0].task, "build feature X");
  });

  it("ignores non-JSON messages", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from("not json at all"));
    // Should not throw — parseJsonSafe returns null
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    await clientPromise; // resolves fine
  });

  it("records telemetry on open, ready, close", async () => {
    const deps = makeDeps();
    const { createRealtimeClient } = initGatewayWs(deps);

    const clientPromise = createRealtimeClient({ onEnvelope: () => {} });
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "server.hello" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello.ack" })));
    await clientPromise;

    const names = deps._telemetryLog.map((t) => t.name);
    assert.ok(names.includes("realtime_open"));
    assert.ok(names.includes("realtime_ready"));
  });
});

describe("initGatewayWs return shape", () => {
  it("returns all three expected functions", () => {
    const deps = makeDeps();
    const api = initGatewayWs(deps);
    assert.equal(typeof api.createRealtimeClient, "function");
    assert.equal(typeof api.createBridge, "function");
    assert.equal(typeof api.runRealtimeDaemon, "function");
  });
});
