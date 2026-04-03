/**
 * Integration tests for the RT bus — real WebSocket server + real client.
 *
 * Spins up a minimal in-process ws-router-style server, connects real
 * gateway-ws clients, and verifies end-to-end message flow:
 *   - Handshake (server.hello → hello → hello.ack → subscribe)
 *   - Publish/subscribe message delivery
 *   - Task dispatch and ACK round-trip
 *   - Agent-targeted vs broadcast routing
 *
 * Run with: node --test test/integration/rt-bus-integration.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

// ── Minimal RT server (mimics ws-router protocol) ──────────────────────────

class MiniRtServer extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.agents = new Map(); // agentName → ws
    this.wss = null;
  }

  start() {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port }, resolve);
      this.wss.on("connection", (ws) => this._onConnection(ws));
    });
  }

  _onConnection(ws) {
    let agentName = null;
    let authenticated = false;
    let subscriptions = [];

    // Send server.hello to initiate handshake
    ws.send(JSON.stringify({ type: "server.hello" }));

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.emit("frame", msg);

      switch (msg.type) {
        case "hello":
          agentName = msg.agent;
          authenticated = true;
          this.agents.set(agentName, ws);
          ws.send(JSON.stringify({ type: "hello.ack" }));
          break;

        case "subscribe":
          subscriptions = msg.channels || [];
          break;

        case "publish": {
          const { channel, messageType, to, payload, taskId } = msg;
          const envelope = {
            id: `msg-${crypto.randomUUID().slice(0, 8)}`,
            type: messageType || "task",
            from: agentName,
            to: to || "broadcast",
            channel,
            taskId,
            payload: payload || {},
          };

          // Route to target agent or broadcast
          if (to && to !== "broadcast" && this.agents.has(to)) {
            const targetWs = this.agents.get(to);
            if (targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify(envelope));
            }
          } else {
            // Broadcast to all agents except sender
            for (const [name, client] of this.agents) {
              if (name !== agentName && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(envelope));
              }
            }
          }
          break;
        }

        case "ack":
          this.emit("ack", { from: agentName, ...msg });
          break;
      }
    });

    ws.on("close", () => {
      if (agentName) this.agents.delete(agentName);
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const ws of this.agents.values()) ws.close();
      this.agents.clear();
      if (this.wss) this.wss.close(resolve);
      else resolve();
    });
  }
}

// ── Minimal RT client (simplified gateway-ws) ──────────────────────────────

function createTestClient(url, agentName, token = "test-token") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    let ready = false;

    ws.on("open", () => {
      // Wait for server.hello
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "server.hello") {
        ws.send(JSON.stringify({ type: "hello", agent: agentName, token }));
        return;
      }

      if (msg.type === "hello.ack") {
        ws.send(JSON.stringify({ type: "subscribe", channels: ["command", "events", "done"] }));
        ready = true;
        resolve(client);
        return;
      }

      // Any other message is an envelope
      received.push(msg);
      client.emit("envelope", msg);
    });

    ws.on("error", reject);

    const client = new EventEmitter();
    client.ws = ws;
    client.received = received;
    client.isReady = () => ready;

    client.publish = ({ channel = "command", messageType = "task", to = "broadcast", taskId, payload = {} }) => {
      ws.send(JSON.stringify({ type: "publish", channel, messageType, to, taskId, payload }));
    };

    client.ack = ({ messageId, status = "received", note }) => {
      ws.send(JSON.stringify({ type: "ack", messageId, status, note }));
    };

    client.close = () => {
      ws.close();
    };

    client.waitForEnvelope = (timeoutMs = 2000) => {
      if (received.length > 0) return Promise.resolve(received[received.length - 1]);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error("Timeout waiting for envelope")), timeoutMs);
        client.once("envelope", (env) => {
          clearTimeout(timer);
          res(env);
        });
      });
    };
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

const PORT = 18950 + Math.floor(Math.random() * 100);

describe("RT bus integration", () => {
  let server;

  beforeEach(async () => {
    server = new MiniRtServer(PORT);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("completes full handshake: server.hello → hello → hello.ack → subscribe", async () => {
    const frames = [];
    server.on("frame", (f) => frames.push(f));

    const client = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-test");

    assert.ok(client.isReady());
    // Small delay for subscribe frame to arrive at server
    await new Promise(r => setTimeout(r, 50));
    assert.ok(frames.some(f => f.type === "hello" && f.agent === "crew-test"));
    assert.ok(frames.some(f => f.type === "subscribe"));

    client.close();
  });

  it("delivers broadcast message to all connected agents", async () => {
    const agent1 = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-coder");
    const agent2 = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-qa");
    const lead = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-lead");

    // Small delay for connections to settle
    await new Promise(r => setTimeout(r, 50));

    // crew-lead broadcasts a task
    lead.publish({
      channel: "command",
      messageType: "command.run_task",
      to: "broadcast",
      taskId: "task-001",
      payload: { prompt: "Build a hello world app" },
    });

    const env1 = await agent1.waitForEnvelope();
    const env2 = await agent2.waitForEnvelope();

    assert.equal(env1.from, "crew-lead");
    assert.equal(env1.taskId, "task-001");
    assert.equal(env1.payload.prompt, "Build a hello world app");

    assert.equal(env2.from, "crew-lead");
    assert.equal(env2.taskId, "task-001");

    // Lead should NOT receive its own broadcast
    assert.equal(lead.received.length, 0);

    agent1.close();
    agent2.close();
    lead.close();
  });

  it("delivers targeted message only to the specified agent", async () => {
    const coder = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-coder");
    const qa = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-qa");
    const lead = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-lead");

    await new Promise(r => setTimeout(r, 50));

    // Send targeted message to crew-coder only
    lead.publish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-coder",
      taskId: "task-002",
      payload: { prompt: "Fix the bug in auth.js" },
    });

    const env = await coder.waitForEnvelope();
    assert.equal(env.to, "crew-coder");
    assert.equal(env.taskId, "task-002");

    // crew-qa should NOT receive the targeted message
    await new Promise(r => setTimeout(r, 100));
    assert.equal(qa.received.length, 0, "crew-qa should not receive targeted message");

    coder.close();
    qa.close();
    lead.close();
  });

  it("agent can ACK a received message", async () => {
    const coder = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-coder");
    const lead = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-lead");

    await new Promise(r => setTimeout(r, 50));

    const acks = [];
    server.on("ack", (a) => acks.push(a));

    lead.publish({
      channel: "command",
      messageType: "task",
      to: "crew-coder",
      taskId: "task-003",
      payload: { prompt: "test" },
    });

    const env = await coder.waitForEnvelope();
    coder.ack({ messageId: env.id, status: "done", note: "completed" });

    await new Promise(r => setTimeout(r, 50));
    assert.ok(acks.some(a => a.from === "crew-coder" && a.status === "done"));

    coder.close();
    lead.close();
  });

  it("agent publishes done result back to crew-lead", async () => {
    const coder = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-coder");
    const lead = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-lead");

    await new Promise(r => setTimeout(r, 50));

    // crew-coder sends result back to crew-lead
    coder.publish({
      channel: "done",
      messageType: "task.done",
      to: "crew-lead",
      taskId: "task-004",
      payload: { reply: "Built the app successfully", exitCode: 0 },
    });

    const result = await lead.waitForEnvelope();
    assert.equal(result.from, "crew-coder");
    assert.equal(result.type, "task.done");
    assert.equal(result.payload.reply, "Built the app successfully");
    assert.equal(result.taskId, "task-004");

    coder.close();
    lead.close();
  });

  it("handles multiple agents connecting and disconnecting", async () => {
    const agents = [];
    for (let i = 0; i < 5; i++) {
      agents.push(await createTestClient(`ws://127.0.0.1:${PORT}`, `crew-agent-${i}`));
    }

    assert.equal(server.agents.size, 5);

    // Disconnect 2 agents
    agents[1].close();
    agents[3].close();
    await new Promise(r => setTimeout(r, 100));

    assert.equal(server.agents.size, 3);

    // Broadcast from remaining agent should reach other remaining agents
    agents[0].publish({
      channel: "events",
      messageType: "heartbeat",
      payload: { status: "alive" },
    });

    await new Promise(r => setTimeout(r, 100));

    // agents 2 and 4 should receive (not 0=sender, 1 and 3=disconnected)
    assert.ok(agents[2].received.length > 0);
    assert.ok(agents[4].received.length > 0);

    for (const a of agents) a.close();
  });

  it("full dispatch round-trip: lead → agent → result → lead", async () => {
    const lead = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-lead");
    const coder = await createTestClient(`ws://127.0.0.1:${PORT}`, "crew-coder");

    await new Promise(r => setTimeout(r, 50));

    // 1. crew-lead dispatches task to crew-coder
    lead.publish({
      channel: "command",
      messageType: "command.run_task",
      to: "crew-coder",
      taskId: "task-roundtrip",
      payload: { prompt: "Create hello.js" },
    });

    // 2. crew-coder receives task
    const task = await coder.waitForEnvelope();
    assert.equal(task.type, "command.run_task");
    assert.equal(task.payload.prompt, "Create hello.js");

    // 3. crew-coder ACKs receipt
    coder.ack({ messageId: task.id, status: "received" });

    // 4. crew-coder sends result back
    coder.publish({
      channel: "done",
      messageType: "task.done",
      to: "crew-lead",
      taskId: "task-roundtrip",
      payload: {
        reply: "Created hello.js with console.log('hello')",
        exitCode: 0,
        filesWritten: ["/tmp/project/hello.js"],
      },
    });

    // 5. crew-lead receives result
    const result = await lead.waitForEnvelope();
    assert.equal(result.type, "task.done");
    assert.equal(result.taskId, "task-roundtrip");
    assert.ok(result.payload.reply.includes("hello.js"));

    lead.close();
    coder.close();
  });
});
