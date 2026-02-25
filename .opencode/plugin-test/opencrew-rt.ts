import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import type { IncomingMessage } from "node:http"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import WebSocket, { WebSocketServer } from "ws"

type ToolContext = {
  agent?: string
}

type Priority = "low" | "medium" | "high" | "critical"

type ProtocolEnvelope = {
  id: string
  ts: string
  sender_agent_id: string
  sender_type: "main" | "subagent" | "cron" | "external" | "human"
  channel: string
  from: string
  to: string
  type: string
  taskId?: string
  correlationId?: string
  priority?: Priority
  payload: Record<string, unknown>
}

type ClientMeta = {
  id: string
  agent: string
  authed: boolean
  subscriptions: Set<string>
  connectedAt: string
  lastSeenAt: string
  rateWindowStartMs: number
  rateCount: number
}

type RuntimeConfig = {
  host: string
  port: number
  secure: boolean
  requireToken: boolean
  token: string
  tlsKeyPath?: string
  tlsCertPath?: string
}

const DEFAULT_ALLOWED_AGENTS = "main,admin,build,coder,researcher,architect,reviewer,qa,fixer,pm,orchestrator,openclaw,openclaw-main,opencode-pm,opencode-qa,opencode-fixer,opencode-coder,opencode-coder-2,security"
const ALLOWED_AGENTS = (process.env.OPENCLAW_ALLOWED_AGENTS || DEFAULT_ALLOWED_AGENTS)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const API_KEY = (process.env.OPENCLAW_API_KEY || "").trim()
const REQUIRE_API_KEY = (process.env.OPENCLAW_REQUIRE_API_KEY || "1") !== "0"

const MEMORY_BASE_DIR = process.env.SHARED_MEMORY_DIR || `${process.env.HOME}/.openclaw/workspace/shared-memory`
const MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm"
const PROTOCOL_DIR = join(MEMORY_BASE_DIR, MEMORY_NAMESPACE, "opencrew-rt")
const CHANNEL_DIR = join(PROTOCOL_DIR, "channels")
const EVENT_LOG = join(PROTOCOL_DIR, "events.jsonl")
const ACK_LOG = join(PROTOCOL_DIR, "acks.jsonl")

const DEFAULT_HOST = process.env.OPENCREW_RT_HOST || "127.0.0.1"
const DEFAULT_PORT = Number(process.env.OPENCREW_RT_PORT || "18889")
const DEFAULT_REQUIRE_TOKEN = (process.env.OPENCREW_RT_REQUIRE_TOKEN || "1") !== "0"
const DEFAULT_AUTH_TOKEN = process.env.OPENCREW_RT_AUTH_TOKEN || ""
const DEFAULT_TLS_KEY = process.env.OPENCREW_RT_TLS_KEY_PATH
const DEFAULT_TLS_CERT = process.env.OPENCREW_RT_TLS_CERT_PATH
const DEFAULT_AUTO_START = (process.env.OPENCREW_RT_AUTO_START || "1") !== "0"
const DEFAULT_BOOTSTRAP_CHANNELS = (process.env.OPENCREW_RT_BOOTSTRAP_CHANNELS || "1") !== "0"
const STANDARD_CHANNELS = ["command", "assign", "status", "issues", "handoff", "done", "reassign", "events", "dlq"]
const MAX_MESSAGE_BYTES = Number(process.env.OPENCREW_RT_MAX_MESSAGE_BYTES || "65536")
const RATE_LIMIT_PER_MIN = Number(process.env.OPENCREW_RT_RATE_LIMIT_PER_MIN || "300")
const REQUIRE_AGENT_TOKEN = (process.env.OPENCREW_RT_REQUIRE_AGENT_TOKEN || "0") === "1"
const ALLOWED_ORIGINS = (process.env.OPENCREW_RT_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const COMMAND_TYPES = new Set([
  "command.spawn_agent",
  "command.run_task",
  "command.cancel_task",
  "command.reassign_task",
  "command.collect_status",
])
const BOOT_STATUS_FILE = join(PROTOCOL_DIR, "boot-status.json")
const AGENT_TOKENS = new Map<string, string>(
  (process.env.OPENCREW_RT_AGENT_TOKENS || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":")
      if (idx <= 0) return ["", ""] as [string, string]
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()] as [string, string]
    })
    .filter(([agent, token]) => Boolean(agent && token)),
)

const state: {
  server: HttpServer | HttpsServer | null
  wss: WebSocketServer | null
  clients: Map<WebSocket, ClientMeta>
  config: RuntimeConfig | null
} = {
  server: null,
  wss: null,
  clients: new Map(),
  config: null,
}

function failUnauthorized(reason: string): never {
  throw new Error(`[opencrew-rt] Unauthorized: ${reason}`)
}

function checkPermissions(context: ToolContext | undefined, providedKey?: string): string {
  const agentId = context?.agent || "anonymous"
  if (!ALLOWED_AGENTS.includes(agentId) && !ALLOWED_AGENTS.includes("*")) {
    failUnauthorized(`agent "${agentId}" not in allowlist`)
  }

  if (REQUIRE_API_KEY && !API_KEY) {
    failUnauthorized("OPENCLAW_API_KEY is required but not configured")
  }

  if (REQUIRE_API_KEY) {
    const key = (providedKey || "").trim()
    if (!key || key !== API_KEY) {
      failUnauthorized("invalid API key")
    }
  }
  return agentId
}

function sanitizeChannel(channel: string): string {
  const value = channel.trim().toLowerCase()
  if (!/^[a-z0-9._-]{1,40}$/.test(value)) {
    throw new Error("[opencrew-rt] Invalid channel. Use 1-40 chars: a-z 0-9 . _ -")
  }
  return value
}

function sanitizeType(type: string): string {
  const value = type.trim().toLowerCase()
  if (!/^[a-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("[opencrew-rt] Invalid message type. Use 1-64 chars: a-z 0-9 . _ -")
  }
  return value
}

function sanitizeTarget(to?: string): string {
  const value = (to || "broadcast").trim()
  if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(value)) {
    throw new Error("[opencrew-rt] Invalid target. Use 1-80 chars: letters, numbers, . _ : -")
  }
  return value
}

function normalizePriority(priority?: string): Priority {
  const value = (priority || "medium").trim().toLowerCase()
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value
  }
  throw new Error("[opencrew-rt] Invalid priority. Use: low, medium, high, critical")
}

function assertOriginAllowed(req: IncomingMessage): void {
  if (!ALLOWED_ORIGINS.length) return
  const origin = String(req.headers.origin || "")
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    throw new Error(`origin not allowed: ${origin || "(missing)"}`)
  }
}

function validateRealtimeToken(claimedAgent: string, token: string): void {
  const perAgentToken = AGENT_TOKENS.get(claimedAgent)
  if (perAgentToken) {
    if (token !== perAgentToken) throw new Error("invalid per-agent realtime token")
    return
  }

  if (REQUIRE_AGENT_TOKEN) {
    throw new Error(`missing per-agent token for ${claimedAgent}`)
  }

  if (state.config?.requireToken) {
    if (!state.config.token || token !== state.config.token) {
      throw new Error("invalid realtime token")
    }
  }
}

function enforceRateLimit(meta: ClientMeta): void {
  const now = Date.now()
  if (now - meta.rateWindowStartMs >= 60000) {
    meta.rateWindowStartMs = now
    meta.rateCount = 0
  }
  meta.rateCount += 1
  if (meta.rateCount > RATE_LIMIT_PER_MIN) {
    throw new Error(`rate limit exceeded: ${RATE_LIMIT_PER_MIN}/min`)
  }
}

function validateEnvelopeSemantics(envelope: ProtocolEnvelope): void {
  if (envelope.channel === "command" && !COMMAND_TYPES.has(envelope.type)) {
    throw new Error(`[opencrew-rt] Invalid command type: ${envelope.type}`)
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { text: raw }
  }
}

async function ensureProtocolDirs(): Promise<void> {
  if (!existsSync(PROTOCOL_DIR)) await mkdir(PROTOCOL_DIR, { recursive: true })
  if (!existsSync(CHANNEL_DIR)) await mkdir(CHANNEL_DIR, { recursive: true })
}

async function ensureChannelFiles(channels = STANDARD_CHANNELS): Promise<void> {
  await ensureProtocolDirs()
  for (const channel of channels) {
    const filePath = channelPath(channel)
    if (!existsSync(filePath)) {
      await appendFile(filePath, "", "utf8")
    }
  }
}

async function writeBootStatus(status: Record<string, unknown>): Promise<void> {
  await ensureProtocolDirs()
  await writeFile(BOOT_STATUS_FILE, JSON.stringify(status, null, 2), "utf8")
}

function buildRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    host: overrides.host || DEFAULT_HOST,
    port: overrides.port || DEFAULT_PORT,
    secure: overrides.secure ?? Boolean(DEFAULT_TLS_KEY && DEFAULT_TLS_CERT),
    requireToken: overrides.requireToken ?? DEFAULT_REQUIRE_TOKEN,
    token: overrides.token || DEFAULT_AUTH_TOKEN,
    tlsKeyPath: overrides.tlsKeyPath || DEFAULT_TLS_KEY,
    tlsCertPath: overrides.tlsCertPath || DEFAULT_TLS_CERT,
  }
}

function channelPath(channel: string): string {
  return join(CHANNEL_DIR, `${sanitizeChannel(channel)}.jsonl`)
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8")
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(value))
  }
}

function routeEnvelope(envelope: ProtocolEnvelope): number {
  let delivered = 0
  for (const [socket, meta] of state.clients.entries()) {
    if (!meta.authed || socket.readyState !== WebSocket.OPEN) continue
    const isTargeted = envelope.to !== "broadcast"
    const isDirectTarget = meta.agent === envelope.to || meta.id === envelope.to
    const isSubscribed = meta.subscriptions.has("*") || meta.subscriptions.has(envelope.channel)
    if ((isTargeted && isDirectTarget) || (!isTargeted && isSubscribed)) {
      sendJson(socket, { type: "message", envelope })
      delivered += 1
    }
  }
  return delivered
}

async function publishEnvelope(envelope: ProtocolEnvelope): Promise<{ delivered: number }> {
  await ensureProtocolDirs()
  validateEnvelopeSemantics(envelope)
  await appendJsonLine(channelPath(envelope.channel), envelope)
  await appendJsonLine(EVENT_LOG, { event: "published", envelope })
  const delivered = routeEnvelope(envelope)
  return { delivered }
}

function getSenderType(agentId: string): ProtocolEnvelope["sender_type"] {
  if (agentId.startsWith("cron:")) return "cron"
  if (agentId.startsWith("ext:")) return "external"
  if (agentId === "openclaw-main") return "main"
  if (agentId.startsWith("openclaw") || agentId.includes("main")) return "main"
  if (agentId === "anonymous" || agentId === "human" || agentId === "user") return "human"
  return "subagent"
}

async function createAndPublishEnvelope(input: {
  channel: string
  type: string
  from: string
  to?: string
  taskId?: string
  correlationId?: string
  priority?: string
  payload?: Record<string, unknown>
}): Promise<{ envelope: ProtocolEnvelope; delivered: number }> {
  const sender_agent_id = input.from
  const sender_type = getSenderType(sender_agent_id)
  const envelope: ProtocolEnvelope = {
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
  }
  const { delivered } = await publishEnvelope(envelope)
  return { envelope, delivered }
}

export function runtimeStatus() {
  const channels: Record<string, number> = {}
  for (const meta of state.clients.values()) {
    for (const channel of meta.subscriptions) {
      channels[channel] = (channels[channel] || 0) + 1
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
  }
}

function setupConnectionHandlers(): void {
  if (!state.wss) return

  state.wss.on("connection", (socket, req) => {
    try {
      assertOriginAllowed(req)
    } catch (err) {
      sendJson(socket, { type: "error", message: (err as Error).message })
      socket.close()
      return
    }

    const meta: ClientMeta = {
      id: randomUUID(),
      agent: "anonymous",
      authed: false,
      subscriptions: new Set(["events"]),
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      rateWindowStartMs: Date.now(),
      rateCount: 0,
    }
    state.clients.set(socket, meta)
    sendJson(socket, {
      type: "server.hello",
      protocol: "opencrew-rt/1",
      requiresAuth: Boolean(state.config?.requireToken),
      ts: new Date().toISOString(),
    })

    socket.on("message", async (raw) => {
      try {
        const rawBytes = typeof raw === "string"
          ? Buffer.byteLength(raw)
          : Array.isArray(raw)
            ? raw.reduce((n, chunk) => n + chunk.length, 0)
            : raw.byteLength
        if (rawBytes > MAX_MESSAGE_BYTES) {
          throw new Error(`message exceeds max size (${MAX_MESSAGE_BYTES} bytes)`)
        }
        meta.lastSeenAt = new Date().toISOString()
        enforceRateLimit(meta)
        const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>
        const kind = String(parsed.type || "")

        if (kind === "ping") {
          sendJson(socket, { type: "pong", ts: new Date().toISOString() })
          return
        }

        if (kind === "hello") {
          const claimedAgent = String(parsed.agent || "anonymous")
          const token = String(parsed.token || "")
          if (!ALLOWED_AGENTS.includes(claimedAgent) && !ALLOWED_AGENTS.includes("*")) {
            throw new Error(`agent not allowed: ${claimedAgent}`)
          }
          validateRealtimeToken(claimedAgent, token)
          meta.agent = claimedAgent
          meta.authed = true
          sendJson(socket, {
            type: "hello.ack",
            clientId: meta.id,
            agent: meta.agent,
            subscriptions: [...meta.subscriptions],
          })
          return
        }

        if (!meta.authed) {
          throw new Error("must send hello before using protocol")
        }

        if (kind === "subscribe") {
          const channels = Array.isArray(parsed.channels) ? parsed.channels : []
          for (const rawChannel of channels) {
            const safe = sanitizeChannel(String(rawChannel))
            meta.subscriptions.add(safe)
          }
          sendJson(socket, { type: "subscribe.ack", channels: [...meta.subscriptions] })
          return
        }

        if (kind === "publish") {
          const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload as Record<string, unknown> : {}
          const { envelope, delivered } = await createAndPublishEnvelope({
            channel: String(parsed.channel || "events"),
            type: String(parsed.messageType || "event"),
            from: meta.agent,
            to: parsed.to ? String(parsed.to) : "broadcast",
            taskId: parsed.taskId ? String(parsed.taskId) : undefined,
            correlationId: parsed.correlationId ? String(parsed.correlationId) : undefined,
            priority: parsed.priority ? String(parsed.priority) : "medium",
            payload,
          })
          sendJson(socket, { type: "publish.ack", id: envelope.id, delivered })
          return
        }

        if (kind === "ack") {
          const ack = {
            id: randomUUID(),
            ts: new Date().toISOString(),
            from: meta.agent,
            messageId: String(parsed.messageId || ""),
            status: String(parsed.status || "received"),
            note: String(parsed.note || ""),
          }
          await ensureProtocolDirs()
          await appendJsonLine(ACK_LOG, ack)
          sendJson(socket, { type: "ack.logged", ack })
          return
        }

        throw new Error(`unsupported message type: ${kind}`)
      } catch (err) {
        sendJson(socket, { type: "error", message: (err as Error).message })
      }
    })

    socket.on("close", () => {
      state.clients.delete(socket)
    })

    socket.on("error", () => {
      state.clients.delete(socket)
    })
  })
}

export async function startServer(config: RuntimeConfig): Promise<void> {
  if (state.server || state.wss) {
    throw new Error("[opencrew-rt] Server already running")
  }
  await ensureProtocolDirs()

  let server: HttpServer | HttpsServer
  if (config.secure) {
    if (!config.tlsKeyPath || !config.tlsCertPath) {
      throw new Error("[opencrew-rt] TLS enabled but key/cert paths are missing")
    }
    const [key, cert] = await Promise.all([
      readFile(config.tlsKeyPath, "utf8"),
      readFile(config.tlsCertPath, "utf8"),
    ])
    server = createHttpsServer({ key, cert })
  } else {
    server = createHttpServer()
  }

  const wss = new WebSocketServer({ server })
  state.server = server
  state.wss = wss
  state.config = config
  setupConnectionHandlers()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port, config.host, () => resolve())
  })

  await appendJsonLine(EVENT_LOG, {
    event: "server.started",
    ts: new Date().toISOString(),
    host: config.host,
    port: config.port,
    secure: config.secure,
  })
}

async function stopServer(): Promise<void> {
  const wss = state.wss
  const server = state.server
  if (!wss || !server) return

  for (const socket of state.clients.keys()) {
    socket.close()
  }

  await new Promise<void>((resolve) => {
    wss.close(() => resolve())
  })

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  state.clients.clear()
  state.server = null
  state.wss = null
  state.config = null
  await appendJsonLine(EVENT_LOG, { event: "server.stopped", ts: new Date().toISOString() })
}

async function readChannelMessages(channel: string, limit: number): Promise<ProtocolEnvelope[]> {
  const filePath = channelPath(channel)
  if (!existsSync(filePath)) return []

  const raw = await readFile(filePath, "utf8")
  const lines = raw.split("\n").filter(Boolean)
  const out: ProtocolEnvelope[] = []

  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ProtocolEnvelope)
    } catch {
      // skip malformed lines
    }
  }
  if (out.length <= limit) return out
  return out.slice(out.length - limit)
}

export const OpenCrewRealtimePlugin: Plugin = async () => {
  await ensureProtocolDirs()
  if (DEFAULT_BOOTSTRAP_CHANNELS) {
    await ensureChannelFiles()
  }

  await appendJsonLine(EVENT_LOG, {
    event: "plugin.loaded",
    ts: new Date().toISOString(),
    autoStart: DEFAULT_AUTO_START,
    bootstrapChannels: DEFAULT_BOOTSTRAP_CHANNELS,
  })

  if (DEFAULT_AUTO_START && !state.server) {
    try {
      const config = buildRuntimeConfig()
      if (config.requireToken && !config.token) {
        throw new Error("OPENCREW_RT_AUTH_TOKEN is required when OPENCREW_RT_REQUIRE_TOKEN=1")
      }
      await startServer(config)
      await createAndPublishEnvelope({
        channel: "events",
        type: "system.online",
        from: "system",
        to: "broadcast",
        priority: "high",
        payload: {
          endpoint: `${config.secure ? "wss" : "ws"}://${config.host}:${config.port}`,
          protocol: "opencrew-rt/1",
        },
      })
      await writeBootStatus({
        ts: new Date().toISOString(),
        status: "started",
        endpoint: `${config.secure ? "wss" : "ws"}://${config.host}:${config.port}`,
      })
    } catch (err) {
      await appendJsonLine(EVENT_LOG, {
        event: "server.autostart_failed",
        ts: new Date().toISOString(),
        message: (err as Error).message,
      })
      await writeBootStatus({
        ts: new Date().toISOString(),
        status: "autostart_failed",
        error: (err as Error).message,
      })
    }
  }

  interface AuthArgs {
    apiKey?: string
  }

  interface ServerArgs extends AuthArgs {
    action: "start" | "stop" | "status"
    host?: string
    port?: number
    secure?: boolean
    requireToken?: boolean
    authToken?: string
    tlsKeyPath?: string
    tlsCertPath?: string
  }

  interface PublishArgs extends AuthArgs {
    channel: string
    type: string
    to?: string
    taskId?: string
    correlationId?: string
    priority?: Priority
    payload?: string
  }

  interface PullArgs extends AuthArgs {
    channel: string
    since?: string
    forAgent?: string
    limit?: number
  }

  interface AckArgs extends AuthArgs {
    messageId: string
    status?: string
    note?: string
  }

  interface AssignArgs extends AuthArgs {
    to: string
    taskId: string
    title: string
    description: string
    acceptance?: string
    priority?: Priority
    dueAt?: string
  }

  interface IssueArgs extends AuthArgs {
    to: string
    taskId: string
    issue: string
    repro?: string
    severity?: "low" | "medium" | "high" | "critical"
  }

  interface CommandArgs extends AuthArgs {
    to: string
    taskId: string
    action: "spawn_agent" | "run_task" | "cancel_task" | "reassign_task" | "collect_status"
    payload?: string
    priority?: Priority
  }

  return {
    tool: {
      opencrew_rt_server: tool({
        description: "Start/stop/status for the OpenCrew realtime WS/WSS control plane",
        args: {
          action: tool.schema.enum(["start", "stop", "status"]).describe("Server action"),
          host: tool.schema.string().optional().describe("Bind host (default from OPENCREW_RT_HOST or 127.0.0.1)"),
          port: tool.schema.number().int().optional().describe("Bind port (default OPENCREW_RT_PORT or 18889)"),
          secure: tool.schema.boolean().optional().describe("Enable WSS (TLS)"),
          requireToken: tool.schema.boolean().optional().describe("Require hello token auth for socket clients"),
          authToken: tool.schema.string().optional().describe("Realtime token override for this process"),
          tlsKeyPath: tool.schema.string().optional().describe("TLS key path for WSS"),
          tlsCertPath: tool.schema.string().optional().describe("TLS cert path for WSS"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: ServerArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            if (args.action === "status") {
              return JSON.stringify(runtimeStatus(), null, 2)
            }

            if (args.action === "stop") {
              await stopServer()
              await writeBootStatus({
                ts: new Date().toISOString(),
                status: "stopped",
              })
              return "[opencrew-rt] Server stopped"
            }

            const config: RuntimeConfig = buildRuntimeConfig({
              host: args.host,
              port: args.port,
              secure: args.secure,
              requireToken: args.requireToken,
              token: args.authToken,
              tlsKeyPath: args.tlsKeyPath,
              tlsCertPath: args.tlsCertPath,
            })

            if (config.requireToken && !config.token) {
              throw new Error("[opencrew-rt] OPENCREW_RT_AUTH_TOKEN is required when token auth is enabled")
            }

            await startServer(config)
            await writeBootStatus({
              ts: new Date().toISOString(),
              status: "started",
              endpoint: `${config.secure ? "wss" : "ws"}://${config.host}:${config.port}`,
            })
            return `[opencrew-rt] Server started on ${config.secure ? "wss" : "ws"}://${config.host}:${config.port}`
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),

      opencrew_rt_publish: tool({
        description: "Publish a realtime protocol envelope and persist to shared memory",
        args: {
          channel: tool.schema.string().describe("Channel name (assign, status, issues, handoff, done, reassign, etc.)"),
          type: tool.schema.string().describe("Message type (task.assigned, qa.issue, task.done, etc.)"),
          to: tool.schema.string().optional().describe("Target agent/client id (default: broadcast)"),
          taskId: tool.schema.string().optional().describe("Task identifier"),
          correlationId: tool.schema.string().optional().describe("Correlation/thread identifier"),
          priority: tool.schema.enum(["low", "medium", "high", "critical"]).optional().describe("Message priority"),
          payload: tool.schema.string().optional().describe("JSON string payload or plain text"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: PublishArgs, context: ToolContext) {
          try {
            const from = checkPermissions(context, args.apiKey)
            const payload = parsePayload(args.payload || "{}")
            const { envelope, delivered } = await createAndPublishEnvelope({
              channel: args.channel,
              type: args.type,
              from,
              to: args.to,
              taskId: args.taskId,
              correlationId: args.correlationId,
              priority: args.priority,
              payload,
            })
            return JSON.stringify({ ok: true, delivered, envelope }, null, 2)
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),

      opencrew_rt_assign: tool({
        description: "Assign work from PM/orchestrator to an agent using realtime protocol",
        args: {
          to: tool.schema.string().describe("Assignee agent id"),
          taskId: tool.schema.string().describe("Task id"),
          title: tool.schema.string().describe("Task title"),
          description: tool.schema.string().describe("Task details"),
          acceptance: tool.schema.string().optional().describe("Acceptance criteria"),
          dueAt: tool.schema.string().optional().describe("Optional due timestamp (ISO)"),
          priority: tool.schema.enum(["low", "medium", "high", "critical"]).optional().describe("Task priority"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: AssignArgs, context: ToolContext) {
          try {
            const from = checkPermissions(context, args.apiKey)
            const payload: Record<string, unknown> = {
              title: args.title,
              description: args.description,
              acceptance: args.acceptance || "",
              dueAt: args.dueAt || "",
            }
            const { envelope, delivered } = await createAndPublishEnvelope({
              channel: "assign",
              type: "task.assigned",
              from,
              to: args.to,
              taskId: args.taskId,
              priority: args.priority || "high",
              payload,
            })
            return JSON.stringify({ ok: true, delivered, envelope }, null, 2)
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),

      opencrew_rt_issue: tool({
        description: "Report QA issue to fixer/remediator via realtime protocol",
        args: {
          to: tool.schema.string().describe("Target fixer/remediator agent"),
          taskId: tool.schema.string().describe("Task id that failed QA"),
          issue: tool.schema.string().describe("Issue summary"),
          repro: tool.schema.string().optional().describe("Reproduction steps"),
          severity: tool.schema.enum(["low", "medium", "high", "critical"]).optional().describe("Issue severity"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: IssueArgs, context: ToolContext) {
          try {
            const from = checkPermissions(context, args.apiKey)
            const payload: Record<string, unknown> = {
              issue: args.issue,
              repro: args.repro || "",
            }
            const { envelope, delivered } = await createAndPublishEnvelope({
              channel: "issues",
              type: "qa.issue",
              from,
              to: args.to,
              taskId: args.taskId,
              priority: args.severity || "high",
              payload,
            })
            return JSON.stringify({ ok: true, delivered, envelope }, null, 2)
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),

      opencrew_rt_command: tool({
        description: "Publish a command envelope on the command channel",
        args: {
          to: tool.schema.string().describe("Target agent"),
          taskId: tool.schema.string().describe("Task id for tracking and ack"),
          action: tool.schema.enum(["spawn_agent", "run_task", "cancel_task", "reassign_task", "collect_status"]).describe("Command action"),
          payload: tool.schema.string().optional().describe("JSON payload or plain text"),
          priority: tool.schema.enum(["low", "medium", "high", "critical"]).optional().describe("Command priority"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: CommandArgs, context: ToolContext) {
          try {
            const from = checkPermissions(context, args.apiKey)
            const payload = parsePayload(args.payload || "{}")
            const { envelope, delivered } = await createAndPublishEnvelope({
              channel: "command",
              type: `command.${args.action}`,
              from,
              to: args.to,
              taskId: args.taskId,
              priority: args.priority || "high",
              payload,
            })
            return JSON.stringify({ ok: true, delivered, envelope }, null, 2)
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),

      opencrew_rt_pull: tool({
        description: "Pull persisted channel messages from shared memory with filters",
        args: {
          channel: tool.schema.string().describe("Channel to read"),
          since: tool.schema.string().optional().describe("Only messages at/after this ISO timestamp"),
          forAgent: tool.schema.string().optional().describe("Filter for direct + broadcast messages to this agent"),
          limit: tool.schema.number().int().positive().max(500).optional().describe("Max messages (default: 100)"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: PullArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureProtocolDirs()
            const limit = args.limit || 100
            const sinceMs = args.since ? Date.parse(args.since) : Number.NaN
            const forAgent = args.forAgent?.trim()
            const all = await readChannelMessages(args.channel, Math.max(limit * 3, limit))
            const filtered = all.filter((msg) => {
              if (Number.isFinite(sinceMs) && Date.parse(msg.ts) < sinceMs) return false
              if (forAgent && msg.to !== "broadcast" && msg.to !== forAgent) return false
              return true
            })
            return JSON.stringify({
              channel: sanitizeChannel(args.channel),
              count: filtered.length > limit ? limit : filtered.length,
              messages: filtered.slice(-limit),
            }, null, 2)
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),

      opencrew_rt_ack: tool({
        description: "Acknowledge a protocol envelope (received, in_progress, done, failed)",
        args: {
          messageId: tool.schema.string().describe("Envelope id being acknowledged"),
          status: tool.schema.string().optional().describe("Ack status"),
          note: tool.schema.string().optional().describe("Optional ack note"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: AckArgs, context: ToolContext) {
          try {
            const from = checkPermissions(context, args.apiKey)
            if (!args.messageId.trim()) {
              throw new Error("[opencrew-rt] messageId is required")
            }
            await ensureProtocolDirs()
            const ack = {
              id: randomUUID(),
              ts: new Date().toISOString(),
              from,
              messageId: args.messageId.trim(),
              status: (args.status || "received").trim(),
              note: (args.note || "").trim(),
            }
            await appendJsonLine(ACK_LOG, ack)
            return JSON.stringify({ ok: true, ack }, null, 2)
          } catch (err) {
            return `[opencrew-rt] Error: ${(err as Error).message}`
          }
        },
      }),
    },
  }
}

export default OpenCrewRealtimePlugin

// CLI entry point for standalone server
const isMain = import.meta.url === `file://${process.argv[1]}.js`

if (isMain) {
  const args = process.argv.slice(2)
  const action = args[0] || "start"
  
  if (action === "start") {
    const port = Number(process.env.OPENCREW_RT_PORT || "18889")
    const host = process.env.OPENCREW_RT_HOST || "127.0.0.1"
    const requireToken = process.env.OPENCREW_RT_REQUIRE_TOKEN !== "0"
    const token = process.env.OPENCREW_RT_AUTH_TOKEN || ""
    
    console.log(`[opencrew-rt] Starting server on ${host}:${port}...`)
    startServer({
      host,
      port,
      secure: false,
      requireToken,
      token,
    }).then(() => {
      console.log(`[opencrew-rt] Server running on ws://${host}:${port}`)
    }).catch(err => {
      console.error(`[opencrew-rt] Failed to start: ${err.message}`)
      process.exit(1)
    })
  } else if (action === "status") {
    console.log(JSON.stringify(runtimeStatus(), null, 2))
  } else {
    console.log("Usage: node opencrew-rt.js [start|status]")
  }
}
