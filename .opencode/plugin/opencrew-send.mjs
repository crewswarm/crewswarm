#!/usr/bin/env node
import WebSocket from "ws";
import crypto from "node:crypto";

function usage() {
  console.error("Usage: node opencrew-send.mjs --to <agent|broadcast> --prompt <text> [--from <agent>] [--task-id <id>] [--channel <name>] [--type <type>] [--priority <low|medium|high|critical>]");
}

function parseArgs(argv) {
  const out = {
    from: process.env.OPENCREW_RT_SENDER || "orchestrator",
    channel: "command",
    type: "command.run_task",
    priority: "high",
    taskId: `msg-${Date.now()}`,
    to: "",
    prompt: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--to") { out.to = v || ""; i += 1; continue; }
    if (a === "--prompt") { out.prompt = v || ""; i += 1; continue; }
    if (a === "--from") { out.from = v || out.from; i += 1; continue; }
    if (a === "--task-id") { out.taskId = v || out.taskId; i += 1; continue; }
    if (a === "--channel") { out.channel = v || out.channel; i += 1; continue; }
    if (a === "--type") { out.type = v || out.type; i += 1; continue; }
    if (a === "--priority") { out.priority = v || out.priority; i += 1; continue; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.to || !args.prompt) {
  usage();
  process.exit(1);
}

const url = process.env.OPENCREW_RT_URL || "ws://127.0.0.1:18889";
const token = process.env.OPENCREW_RT_AUTH_TOKEN || "";

const ws = new WebSocket(url);
let sent = false;
const timeout = setTimeout(() => {
  console.error("Timed out waiting for publish ack");
  process.exit(1);
}, 15000);

ws.on("message", (buf) => {
  const m = JSON.parse(String(buf));

  if (m.type === "server.hello") {
    ws.send(JSON.stringify({ type: "hello", agent: args.from, token }));
    return;
  }

  if (m.type === "hello.ack" && !sent) {
    sent = true;
    ws.send(JSON.stringify({
      type: "publish",
      channel: args.channel,
      messageType: args.type,
      to: args.to,
      taskId: args.taskId,
      priority: args.priority,
      payload: {
        action: "run_task",
        prompt: args.prompt,
      },
      correlationId: crypto.randomUUID(),
    }));
    return;
  }

  if (m.type === "publish.ack") {
    clearTimeout(timeout);
    console.log(JSON.stringify({ ok: true, id: m.id, delivered: m.delivered, to: args.to, taskId: args.taskId }, null, 2));
    ws.close();
    process.exit(0);
  }

  if (m.type === "error") {
    clearTimeout(timeout);
    console.error(`OpenCrew error: ${m.message}`);
    process.exit(1);
  }
});

ws.on("error", (err) => {
  clearTimeout(timeout);
  console.error(err.message);
  process.exit(1);
});
