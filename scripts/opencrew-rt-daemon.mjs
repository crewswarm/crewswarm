#!/usr/bin/env node
/**
 * OpenCrew RT daemon — WebSocket message bus on port 18889.
 * Standalone server extracted from OpenCrew RT protocol (no OpenCode plugin dependency).
 * Source: ~/swarm/.opencode/plugin-test/opencrew-rt.ts (server + protocol only).
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { BUILT_IN_RT_AGENTS, RT_TO_GATEWAY_AGENT_MAP } from "../lib/agent-registry.mjs";
import { acquireStartupLock } from "../lib/runtime/startup-guard.mjs";
import { appendWithRotation } from "../lib/runtime/log-rotation.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const MAX_CLIENTS = Number(process.env.CREWSWARM_RT_MAX_CLIENTS || "200");

const LEGACY_COMPAT_ALLOWED_AGENTS = new Set([
  "main", "admin", "build", "coder", "researcher", "architect", "reviewer", "qa", "fixer", "pm",
  "orchestrator", "openclaw", "openclaw-main", "opencode-pm", "opencode-qa", "opencode-fixer",
  "opencode-coder", "opencode-coder-2", "security", "crew-coder-2", "crew-lead",
]);

const STATIC_ALLOWED = new Set([
  ...LEGACY_COMPAT_ALLOWED_AGENTS,
  ...BUILT_IN_RT_AGENTS,
  ...Object.keys(RT_TO_GATEWAY_AGENT_MAP),
  ...Object.values(RT_TO_GATEWAY_AGENT_MAP),
]);

function isAgentAllowed(agentId) {
  if (STATIC_ALLOWED.has(agentId) || STATIC_ALLOWED.has("*")) return true;
  const cfgPath = join(process.env.HOME || "", ".crewswarm", "crewswarm.json");
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const agentList = Array.isArray(cfg.agents) ? cfg.agents
      : Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    return agentList.some(a => a.id === agentId);
  } catch { return false; }
}

// Legacy compat: env override still works as a full allowlist
const ENV_OVERRIDE_AGENTS = process.env.OPENCLAW_ALLOWED_AGENTS
  ? new Set(process.env.OPENCLAW_ALLOWED_AGENTS.split(",").map(s => s.trim()).filter(Boolean))
  : null;
const API_KEY = (process.env.CREWSWARM_API_KEY || process.env.OPENCLAW_API_KEY || "").trim();
const REQUIRE_API_KEY = (process.env.OPENCLAW_REQUIRE_API_KEY || "1") !== "0";

const MEMORY_BASE_DIR = process.env.SHARED_MEMORY_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".crewswarm", "workspace", "shared-memory");
const MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm";
const PROTOCOL_DIR = join(MEMORY_BASE_DIR, MEMORY_NAMESPACE, "opencrew-rt");
const CHANNEL_DIR = join(PROTOCOL_DIR, "channels");
const EVENT_LOG = join(PROTOCOL_DIR, "events.jsonl");
const ACK_LOG = join(PROTOCOL_DIR, "acks.jsonl");

const STANDARD_CHANNELS = ["command", "assign", "status", "issues", "handoff", "done", "reassign", "events", "dlq"];
const MAX_MESSAGE_BYTES = Number(process.env.CREWSWARM_RT_MAX_MESSAGE_BYTES || "65536");
const RATE_LIMIT_PER_MIN = Number(process.env.CREWSWARM_RT_RATE_LIMIT_PER_MIN || "300");
const REQUIRE_AGENT_TOKEN = (process.env.CREWSWARM_RT_REQUIRE_AGENT_TOKEN || "0") === "1";
const ALLOWED_ORIGINS = (process.env.CREWSWARM_RT_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const COMMAND_TYPES = new Set([
  "command.spawn_agent",
  "command.run_task",
  "command.cancel_task",
  "command.reassign_task",
  "command.collect_status",
]);
const BOOT_STATUS_FILE = join(PROTOCOL_DIR, "boot-status.json");
const AGENT_TOKENS = new Map(
  (process.env.CREWSWARM_RT_AGENT_TOKENS || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx <= 0) return ["", ""];
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
    })
    .filter(([agent, token]) => Boolean(agent && token))
);

const state = {
  server: null,
  wss: null,
  clients: new Map(),
  config: null,
};

function failUnauthorized(reason) {
  throw new Error(`[opencrew-rt] Unauthorized: ${reason}`);
}

function checkPermissions(context, providedKey) {
  const agentId = (context && context.agent) || "anonymous";
  const allowed = ENV_OVERRIDE_AGENTS ? ENV_OVERRIDE_AGENTS.has(agentId) : isAgentAllowed(agentId);
  if (!allowed) {
    failUnauthorized(`agent "${agentId}" not in allowlist`);
  }
  if (REQUIRE_API_KEY && !API_KEY) {
    failUnauthorized("API key is required (set OPENCLAW_API_KEY or CREWSWARM_API_KEY)");
  }
  if (REQUIRE_API_KEY) {
    const key = (providedKey || "").trim();
    if (!key || key !== API_KEY) failUnauthorized("invalid API key");
  }
  return agentId;
}

function sanitizeChannel(channel) {
  const value = channel.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,40}$/.test(value)) {
    throw new Error("[opencrew-rt] Invalid channel. Use 1-40 chars: a-z 0-9 . _ -");
  }
  return value;
}

function sanitizeType(type) {
  const value = type.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("[opencrew-rt] Invalid message type. Use 1-64 chars: a-z 0-9 . _ -");
  }
  return value;
}

function sanitizeTarget(to) {
  const value = (to || "broadcast").trim();
  if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(value)) {
    throw new Error("[opencrew-rt] Invalid target. Use 1-80 chars: letters, numbers, . _ : -");
  }
  return value;
}

function normalizePriority(priority) {
  const value = (priority || "medium").trim().toLowerCase();
  if (["low", "medium", "high", "critical"].includes(value)) return value;
  throw new Error("[opencrew-rt] Invalid priority. Use: low, medium, high, critical");
}

function assertOriginAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return;
  const origin = String(req.headers.origin || "");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    throw new Error(`origin not allowed: ${origin || "(missing)"}`);
  }
}

function validateRealtimeToken(claimedAgent, token) {
  const perAgentToken = AGENT_TOKENS.get(claimedAgent);
  if (perAgentToken) {
    if (token !== perAgentToken) throw new Error("invalid per-agent realtime token");
    return;
  }
  if (REQUIRE_AGENT_TOKEN) {
    throw new Error(`missing per-agent token for ${claimedAgent}`);
  }
  if (state.config && state.config.requireToken) {
    if (!state.config.token || token !== state.config.token) {
      throw new Error("invalid realtime token");
    }
  }
}

function enforceRateLimit(meta) {
  const now = Date.now();
  if (now - meta.rateWindowStartMs >= 60000) {
    meta.rateWindowStartMs = now;
    meta.rateCount = 0;
  }
  meta.rateCount += 1;
  if (meta.rateCount > RATE_LIMIT_PER_MIN) {
    throw new Error(`rate limit exceeded: ${RATE_LIMIT_PER_MIN}/min`);
  }
}

function validateEnvelopeSemantics(envelope) {
  if (envelope.channel === "command" && !COMMAND_TYPES.has(envelope.type)) {
    throw new Error(`[opencrew-rt] Invalid command type: ${envelope.type}`);
  }
}

function parsePayload(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch {
    return { text: raw };
  }
}

async function ensureProtocolDirs() {
  if (!existsSync(PROTOCOL_DIR)) await mkdir(PROTOCOL_DIR, { recursive: true });
  if (!existsSync(CHANNEL_DIR)) await mkdir(CHANNEL_DIR, { recursive: true });
}

async function ensureChannelFiles(channels = STANDARD_CHANNELS) {
  await ensureProtocolDirs();
  for (const channel of channels) {
    const filePath = channelPath(channel);
    if (!existsSync(filePath)) await appendFile(filePath, "", "utf8");
  }
}

async function writeBootStatus(status) {
  await ensureProtocolDirs();
  await writeFile(BOOT_STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
}

function channelPath(channel) {
  return join(CHANNEL_DIR, `${sanitizeChannel(channel)}.jsonl`);
}

async function appendJsonLine(filePath, value) {
  await appendWithRotation(filePath, `${JSON.stringify(value)}\n`);
}

function sendJson(socket, value) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(value));
  }
}

function routeEnvelope(envelope) {
  let delivered = 0;
  for (const [socket, meta] of state.clients.entries()) {
    if (!meta.authed || socket.readyState !== WebSocket.OPEN) continue;
    const isTargeted = envelope.to !== "broadcast";
    const isDirectTarget = meta.agent === envelope.to || meta.id === envelope.to;
    const isSubscribed = meta.subscriptions.has("*") || meta.subscriptions.has(envelope.channel);
    if ((isTargeted && isDirectTarget) || (!isTargeted && isSubscribed)) {
      sendJson(socket, { type: "message", envelope });
      delivered += 1;
    }
  }
  return delivered;
}

async function publishEnvelope(envelope) {
  await ensureProtocolDirs();
  validateEnvelopeSemantics(envelope);
  await appendJsonLine(channelPath(envelope.channel), envelope);
  await appendJsonLine(EVENT_LOG, { event: "published", envelope });
  const delivered = routeEnvelope(envelope);
  return { delivered };
}

function getSenderType(agentId) {
  if (agentId.startsWith("cron:")) return "cron";
  if (agentId.startsWith("ext:")) return "external";
  if (agentId === "openclaw-main") return "main";
  if (agentId.startsWith("openclaw") || agentId.includes("main")) return "main";
  if (["anonymous", "human", "user"].includes(agentId)) return "human";
  return "subagent";
}

async function createAndPublishEnvelope(input) {
  const sender_agent_id = input.from;
  const sender_type = getSenderType(sender_agent_id);
  const envelope = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    sender_agent_id,
    sender_type,
    channel: sanitizeChannel(input.channel),
    from: input.from,
    to: sanitizeTarget(input.to),
    type: sanitizeType(input.type),
    payload: input.payload || {},
    priority: normalizePriority(input.priority),
    ...(input.taskId ? { taskId: input.taskId.trim() } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId.trim() } : {}),
  };
  const { delivered } = await publishEnvelope(envelope);
  return { envelope, delivered };
}

export function runtimeStatus() {
  const channels = {};
  for (const meta of state.clients.values()) {
    for (const channel of meta.subscriptions) {
      channels[channel] = (channels[channel] || 0) + 1;
    }
  }
  return {
    running: Boolean(state.server && state.wss),
    clients: state.clients.size,
    subscriptions: channels,
    config: state.config,
    protocolDir: PROTOCOL_DIR,
    channelDir: CHANNEL_DIR,
    bootStatusFile: BOOT_STATUS_FILE,
  };
}

function setupConnectionHandlers() {
  if (!state.wss) return;

  state.wss.on("connection", (socket, req) => {
    try {
      assertOriginAllowed(req);
    } catch (err) {
      sendJson(socket, { type: "error", message: err.message });
      socket.close();
      return;
    }

    if (state.clients.size >= MAX_CLIENTS) {
      sendJson(socket, { type: "error", message: `Server at capacity (max ${MAX_CLIENTS} clients)` });
      socket.close();
      console.warn(`[opencrew-rt-daemon] MAX_CLIENTS (${MAX_CLIENTS}) reached — rejected new connection`);
      return;
    }

    const meta = {
      id: randomUUID(),
      agent: "anonymous",
      authed: false,
      subscriptions: new Set(["events"]),
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      rateWindowStartMs: Date.now(),
      rateCount: 0,
    };
    state.clients.set(socket, meta);
    sendJson(socket, {
      type: "server.hello",
      protocol: "opencrew-rt/1",
      requiresAuth: Boolean(state.config && state.config.requireToken),
      ts: new Date().toISOString(),
    });

    socket.on("message", async (raw) => {
      try {
        const rawBytes = typeof raw === "string"
          ? Buffer.byteLength(raw)
          : Array.isArray(raw)
            ? raw.reduce((n, chunk) => n + chunk.length, 0)
            : raw.byteLength;
        if (rawBytes > MAX_MESSAGE_BYTES) {
          throw new Error(`message exceeds max size (${MAX_MESSAGE_BYTES} bytes)`);
        }
        meta.lastSeenAt = new Date().toISOString();
        enforceRateLimit(meta);
        const parsed = JSON.parse(raw.toString("utf8"));
        const kind = String(parsed.type || "");

        if (kind === "ping") {
          sendJson(socket, { type: "pong", ts: new Date().toISOString() });
          return;
        }

        if (kind === "hello") {
          const claimedAgent = String(parsed.agent || "anonymous");
          const token = String(parsed.token || "");
          const helloAllowed = ENV_OVERRIDE_AGENTS ? ENV_OVERRIDE_AGENTS.has(claimedAgent) : isAgentAllowed(claimedAgent);
          if (!helloAllowed) {
            throw new Error(`agent not allowed: ${claimedAgent}`);
          }
          validateRealtimeToken(claimedAgent, token);

          // Evict any stale connections already registered under the same agent name.
          // This prevents reconnect storms (e.g. whatsapp-bridge restarting every 3s)
          // from accumulating hundreds of phantom slots in /status.
          if (claimedAgent !== "anonymous") {
            for (const [otherSocket, otherMeta] of state.clients) {
              if (otherSocket !== socket && otherMeta.agent === claimedAgent) {
                try { otherSocket.close(1000, "replaced by new connection"); } catch {}
                state.clients.delete(otherSocket);
                console.log(`[opencrew-rt-daemon] Evicted stale ${claimedAgent} connection (replaced)`);
              }
            }
          }

          meta.agent = claimedAgent;
          meta.authed = true;
          sendJson(socket, {
            type: "hello.ack",
            clientId: meta.id,
            agent: meta.agent,
            subscriptions: [...meta.subscriptions],
          });
          return;
        }

        if (!meta.authed) {
          throw new Error("must send hello before using protocol");
        }

        if (kind === "subscribe") {
          const channels = Array.isArray(parsed.channels) ? parsed.channels : [];
          for (const rawChannel of channels) {
            meta.subscriptions.add(sanitizeChannel(String(rawChannel)));
          }
          sendJson(socket, { type: "subscribe.ack", channels: [...meta.subscriptions] });
          return;
        }

        if (kind === "publish") {
          const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
          const { envelope, delivered } = await createAndPublishEnvelope({
            channel: String(parsed.channel || "events"),
            type: String(parsed.messageType || "event"),
            from: meta.agent,
            to: parsed.to ? String(parsed.to) : "broadcast",
            taskId: parsed.taskId ? String(parsed.taskId) : undefined,
            correlationId: parsed.correlationId ? String(parsed.correlationId) : undefined,
            priority: parsed.priority ? String(parsed.priority) : "medium",
            payload,
          });
          sendJson(socket, { type: "publish.ack", id: envelope.id, delivered });
          return;
        }

        if (kind === "ack") {
          const ack = {
            id: randomUUID(),
            ts: new Date().toISOString(),
            from: meta.agent,
            messageId: String(parsed.messageId || ""),
            status: String(parsed.status || "received"),
            note: String(parsed.note || ""),
          };
          await ensureProtocolDirs();
          await appendJsonLine(ACK_LOG, ack);
          sendJson(socket, { type: "ack.logged", ack });
          return;
        }

        throw new Error(`unsupported message type: ${kind}`);
      } catch (err) {
        sendJson(socket, { type: "error", message: err.message });
        // Close on auth/fatal errors so the connection doesn't linger in state.clients
        try { socket.close(); } catch {}
      }
    });

    socket.on("close", () => state.clients.delete(socket));
    socket.on("error", () => { state.clients.delete(socket); try { socket.close(); } catch {} });
  });
}

export async function startServer(config) {
  // Startup Guard: Ensure only one RT daemon instance
  const lockResult = acquireStartupLock("opencrew-rt-daemon", { port: config.port, killStale: true });
  if (!lockResult.ok) {
    console.error(`[opencrew-rt] ${lockResult.message}`);
    process.exit(1);
  }

  if (state.server || state.wss) {
    throw new Error("[opencrew-rt] Server already running");
  }
  await ensureProtocolDirs();

  let server;
  if (config.secure) {
    if (!config.tlsKeyPath || !config.tlsCertPath) {
      throw new Error("[opencrew-rt] TLS enabled but key/cert paths are missing");
    }
    const [key, cert] = await Promise.all([
      readFile(config.tlsKeyPath, "utf8"),
      readFile(config.tlsCertPath, "utf8"),
    ]);
    server = createHttpsServer({ key, cert });
  } else {
    server = createHttpServer();
  }

  const wss = new WebSocketServer({ server });
  state.server = server;
  state.wss = wss;
  state.config = config;
  setupConnectionHandlers();

  // HTTP status endpoint: GET /status returns connected agent names
  server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/status") {
      const agents = [];
      for (const meta of state.clients.values()) {
        if (meta.agent && meta.agent !== "anonymous") agents.push(meta.agent);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: true, clients: state.clients.size, agents }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  await appendJsonLine(EVENT_LOG, {
    event: "server.started",
    ts: new Date().toISOString(),
    host: config.host,
    port: config.port,
    secure: config.secure,
  });
}

// CLI entry when run as main module
const scriptPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && (process.argv[1] === scriptPath || process.argv[1].endsWith("opencrew-rt-daemon.mjs"));

if (isMain) {
  const host = process.env.CREWSWARM_RT_HOST || "127.0.0.1";
  const port = Number(process.env.CREWSWARM_RT_PORT || "18889");
  const requireTokenEnv = process.env.CREWSWARM_RT_REQUIRE_TOKEN;
  // Token: env first, then config JSON (dashboard saves to ~/.crewswarm or ~/.openclaw)
  let token = process.env.CREWSWARM_RT_AUTH_TOKEN || "";
  if (!token) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    for (const p of [join(home, ".crewswarm", "config.json"), join(home, ".openclaw", "openclaw.json")]) {
      try {
        const cfg = JSON.parse(readFileSync(p, "utf8"));
        token = cfg?.rt?.authToken || cfg?.env?.CREWSWARM_RT_AUTH_TOKEN || "";
        if (token) break;
      } catch {}
    }
  }
  // No token anywhere: auth is optional (local use). Set CREWSWARM_RT_REQUIRE_TOKEN=1 to require a token.
  const requireToken = requireTokenEnv === "1" || (requireTokenEnv !== "0" && token !== "");

  if (requireToken && !token) {
    console.error("CREWSWARM_RT_AUTH_TOKEN is required when CREWSWARM_RT_REQUIRE_TOKEN=1. Set it in ~/.crewswarm/config.json (rt.authToken) or ~/.openclaw/openclaw.json (env.CREWSWARM_RT_AUTH_TOKEN).");
    process.exit(1);
  }

  (async () => {
    await ensureProtocolDirs();
    await ensureChannelFiles();
    const status = runtimeStatus();
    if (status.running) {
      console.log(`OpenCrew RT already running on ws://${status.config.host}:${status.config.port}`);
      return;
    }
    await startServer({
      host,
      port,
      secure: false,
      requireToken,
      token,
    });
    console.log(`OpenCrew RT started on ws://${host}:${port}`);

    const keepAlive = setInterval(() => {
      const s = runtimeStatus();
      console.log(`[opencrew-rt-daemon] running=${s.running} clients=${s.clients}`);
    }, 60000);
    process.on("SIGINT", () => { clearInterval(keepAlive); process.exit(0); });
    process.on("SIGTERM", () => { clearInterval(keepAlive); process.exit(0); });
  })().catch((err) => {
    console.error("[opencrew-rt-daemon]", err.message);
    process.exit(1);
  });
}
