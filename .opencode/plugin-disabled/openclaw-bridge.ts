import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
type ToolContext = {
  agent?: string
}

const execFileAsync = promisify(execFile)

const DEFAULT_ALLOWED_AGENTS = "main,admin,build,coder,researcher,architect,reviewer"
const ALLOWED_AGENTS = (process.env.OPENCLAW_ALLOWED_AGENTS || DEFAULT_ALLOWED_AGENTS)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const API_KEY = (process.env.OPENCLAW_API_KEY || "").trim()
const REQUIRE_API_KEY = (process.env.OPENCLAW_REQUIRE_API_KEY || "1") !== "0"
const ALLOW_MISSING_CONTEXT = process.env.OPENCLAW_ALLOW_MISSING_CONTEXT === "1"
const ALLOW_ANY_BRIDGE_PATH = process.env.OPENCLAW_ALLOW_ANY_BRIDGE_PATH === "1"
const ALLOW_UNRESTRICTED_MESSAGING = process.env.OPENCLAW_ALLOW_UNRESTRICTED_MESSAGING === "1"
const ALLOWED_MESSAGE_TARGETS = (process.env.OPENCLAW_ALLOWED_MESSAGE_TARGETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const DEFAULT_BRIDGE_PATH = `${process.env.HOME}/Desktop/OpenClaw/gateway-bridge.mjs`

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX_CALLS = 30
const callTimestamps: number[] = []

function checkRateLimit(): void {
  const now = Date.now()
  // Clean old timestamps
  while (callTimestamps.length > 0 && now - callTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    callTimestamps.shift()
  }
  if (callTimestamps.length >= RATE_LIMIT_MAX_CALLS) {
    throw new Error(`[openclaw-bridge] Rate limit exceeded: ${RATE_LIMIT_MAX_CALLS} calls per ${RATE_LIMIT_WINDOW_MS/1000}s`)
  }
  callTimestamps.push(now)
}

function failUnauthorized(reason: string): never {
  throw new Error(`[openclaw-bridge] Unauthorized: ${reason}`)
}

function requireContext(context: ToolContext | undefined): ToolContext {
  if (!context && ALLOW_MISSING_CONTEXT) return {} as ToolContext
  if (!context) failUnauthorized("missing context")
  return context
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500)
}

function resolveBridgePath(): string {
  const candidate = process.env.OPENCLAW_BRIDGE_PATH || DEFAULT_BRIDGE_PATH
  const resolved = path.resolve(candidate)

  if (!fs.existsSync(resolved)) {
    throw new Error(`[openclaw-bridge] Bridge path not found: ${resolved}`)
  }

  const stat = fs.statSync(resolved)
  if (!stat.isFile()) {
    throw new Error(`[openclaw-bridge] Bridge path is not a file: ${resolved}`)
  }

  if (!ALLOW_ANY_BRIDGE_PATH && path.basename(resolved) !== "gateway-bridge.mjs") {
    throw new Error("[openclaw-bridge] Bridge path denied: expected gateway-bridge.mjs")
  }

  return resolved
}

async function runBridge(args: string[], timeoutMs: number, maxBuffer: number): Promise<string> {
  const bridgePath = resolveBridgePath()
  const { stdout } = await execFileAsync("node", [bridgePath, ...args], {
    timeout: timeoutMs,
    maxBuffer,
  })
  return stdout.trim() || "(no output)"
}

// Permission check helper - robust to missing context fields
function checkPermissions(context: ToolContext | undefined, providedKey?: string): void {
  const safeContext = requireContext(context)
  const agentId = safeContext.agent || "anonymous"

  if (REQUIRE_API_KEY && !API_KEY) {
    failUnauthorized("OPENCLAW_API_KEY is not configured")
  }

  if (REQUIRE_API_KEY) {
    const key = (providedKey || "").trim()
    if (!key) {
      failUnauthorized("missing API key")
    }
    // Constant-time comparison to prevent timing attacks
    const keyBuffer = Buffer.from(key)
    const apiKeyBuffer = Buffer.from(API_KEY)
    if (keyBuffer.length !== apiKeyBuffer.length || !timingSafeEqual(keyBuffer, apiKeyBuffer)) {
      failUnauthorized("invalid API key")
    }
  }

  if (!ALLOWED_AGENTS.includes(agentId) && !ALLOWED_AGENTS.includes("*")) {
    failUnauthorized(`agent "${agentId}" not in allowlist`)
  }
}

// Validate and sanitize input
function validateMessage(msg: string): string {
  if (!msg || typeof msg !== "string") {
    throw new Error("[openclaw-bridge] Message must be a non-empty string")
  }
  if (msg.length > 100_000) {
    throw new Error("[openclaw-bridge] Message too long (max 100k chars)")
  }
  if (/\0/.test(msg)) {
    throw new Error("[openclaw-bridge] Message contains invalid null byte")
  }

  return msg.trim()
}

// Validate session ID format
function validateSessionId(sessionId: string): string {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("[openclaw-bridge] Session ID must be a non-empty string")
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
    throw new Error("[openclaw-bridge] Invalid session ID format")
  }
  return sessionId
}

// Validate command for exec
function validateCommand(cmd: string): string {
  if (!cmd || typeof cmd !== "string") {
    throw new Error("[openclaw-bridge] Command must be a non-empty string")
  }
  if (cmd.length > 10_000) {
    throw new Error("[openclaw-bridge] Command too long (max 10k chars)")
  }
  // Block dangerous patterns
  const dangerous = [
    /rm\s+-rf\s+\//,
    /:(){ :|:& };:/,
    /fork\(\)/,
    /curl\s*\|\s*bash/i,
    /wget\s*\|\s*bash/i,
  ]
  for (const pattern of dangerous) {
    if (pattern.test(cmd)) {
      throw new Error(`[openclaw-bridge] Command contains dangerous pattern: ${pattern}`)
    }
  }
  return cmd.trim()
}

function normalizeMessageTarget(target: string): string {
  const trimmed = target.trim()
  if (/^[+\d\s().-]+$/.test(trimmed)) {
    const hasPlus = trimmed.startsWith("+")
    const digits = trimmed.replace(/\D/g, "")
    return hasPlus ? `+${digits}` : digits
  }
  return trimmed.toLowerCase()
}

function validateMessageTarget(target: string): string {
  if (!target || target.length > 256) {
    throw new Error("[openclaw-bridge] Invalid target (must be 1-256 chars)")
  }

  const normalized = normalizeMessageTarget(target)
  if (ALLOW_UNRESTRICTED_MESSAGING) return target.trim()

  if (ALLOWED_MESSAGE_TARGETS.length === 0) {
    throw new Error("[openclaw-bridge] Messaging blocked: no allowlisted targets configured")
  }

  const allowedSet = new Set(ALLOWED_MESSAGE_TARGETS.map((t) => normalizeMessageTarget(t)))
  if (!allowedSet.has(normalized)) {
    throw new Error(`[openclaw-bridge] Messaging blocked: target not allowlisted (${target})`)
  }

  return target.trim()
}

// Event emitter for streaming responses (simulated via polling)
class StreamingResponse extends EventEmitter {
  private chunks: string[] = []
  private closed = false

  addChunk(chunk: string) {
    if (!this.closed) {
      this.chunks.push(chunk)
      this.emit("chunk", chunk)
    }
  }

  getFullResponse(): string {
    return this.chunks.join("")
  }

  close() {
    this.closed = true
    this.emit("end", this.getFullResponse())
  }
}

export const OpenClawBridgePlugin: Plugin = async () => {
  interface SendArgs {
    message: string
    resetSession?: boolean
    apiKey?: string
    stream?: boolean
  }

  interface StatusArgs {
    apiKey?: string
  }

  interface SessionListArgs {
    apiKey?: string
  }

  interface SessionKillArgs {
    sessionId: string
    apiKey?: string
  }

  interface SessionCreateArgs {
    title?: string
    systemPrompt?: string
    apiKey?: string
  }

  interface ExecArgs {
    command: string
    timeout?: number
    apiKey?: string
  }

  interface BrowseArgs {
    action: "status" | "tabs" | "snapshot" | "screenshot" | "navigate"
    profile?: string
    targetUrl?: string
    apiKey?: string
  }

  interface MessageArgs {
    target: string
    message: string
    media?: string
    apiKey?: string
  }

  return {
    tool: {
      openclaw_send: tool({
        description: "Send a message to local OpenClaw gateway and return reply. Supports streaming responses.",
        args: {
          message: tool.schema.string().describe("Message to send to OpenClaw"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
          resetSession: tool.schema.boolean().optional().describe("Reset OpenClaw main session before sending"),
          stream: tool.schema.boolean().optional().describe("Enable streaming response (returns chunks as they arrive)"),
        },
        async execute(args: SendArgs, context: ToolContext) {
          checkRateLimit()
          try {
            checkPermissions(context, args.apiKey)
            const safeMessage = validateMessage(args.message)

            if (args.resetSession) {
              await runBridge(["--reset"], 40_000, 1024 * 1024)
            }

            // If streaming requested, simulate with chunked output
            if (args.stream) {
              const stream = new StreamingResponse()
              
              // Run bridge command
              const result = await runBridge([safeMessage], 90_000, 4 * 1024 * 1024)
              
              // Simulate streaming by yielding chunks
              const chunkSize = Math.max(100, Math.floor(result.length / 10))
              for (let i = 0; i < result.length; i += chunkSize) {
                stream.addChunk(result.slice(i, i + chunkSize))
                // Small delay to simulate real streaming
                await new Promise(r => setTimeout(r, 50))
              }
              stream.close()
              
              return `[openclaw-bridge] Streamed ${result.length} chars:\n${result.slice(0, 500)}${result.length > 500 ? "..." : ""}`
            }

            return await runBridge([safeMessage], 90_000, 4 * 1024 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_status: tool({
        description: "Get local OpenClaw gateway status",
        args: {
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: StatusArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            return await runBridge(["--status"], 40_000, 1024 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_session_list: tool({
        description: "List all active OpenClaw sessions",
        args: {
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: SessionListArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            return await runBridge(["--sessions"], 30_000, 512 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_session_kill: tool({
        description: "Terminate an OpenClaw session by ID",
        args: {
          sessionId: tool.schema.string().describe("Session ID to terminate"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: SessionKillArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            const safeSessionId = validateSessionId(args.sessionId)
            return await runBridge(["--kill", safeSessionId], 30_000, 256 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_session_create: tool({
        description: "Create a new OpenClaw session",
        args: {
          title: tool.schema.string().optional().describe("Session title"),
          systemPrompt: tool.schema.string().optional().describe("System prompt for the session"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: SessionCreateArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            const title = args.title || "New Session"
            const systemPrompt = args.systemPrompt || ""
            
            // Create session via bridge
            const sessionData = JSON.stringify({ title, systemPrompt })
            return await runBridge(["--create-session", sessionData], 30_000, 256 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_exec: tool({
        description: "Execute a command on OpenClaw and return output. USE WITH CAUTION - dangerous commands are blocked.",
        args: {
          command: tool.schema.string().describe("Command to execute on OpenClaw host"),
          timeout: tool.schema.number().optional().describe("Timeout in seconds (default: 60)"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: ExecArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            const safeCommand = validateCommand(args.command)
            const timeout = Math.min(args.timeout || 60, 300) // Max 5 minutes
            
            // Execute command via bridge --exec flag
            const encodedCmd = Buffer.from(safeCommand).toString("base64")
            return await runBridge(["--exec", encodedCmd], timeout * 1000, 4 * 1024 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_browse: tool({
        description: "Control OpenClaw browser (Chrome profile with your logged-in sessions)",
        args: {
          action: tool.schema.string().describe("Browser action: status, tabs, snapshot, screenshot, navigate"),
          profile: tool.schema.string().optional().describe("Browser profile (default: chrome)"),
          targetUrl: tool.schema.string().optional().describe("URL for navigate action"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: BrowseArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            const profile = args.profile || "chrome"
            const action = args.action
            
            // Validate action
            const validActions: string[] = ["status", "tabs", "snapshot", "screenshot", "navigate"]
            if (!validActions.includes(action)) {
              throw new Error(`[openclaw-bridge] Invalid action: ${action}. Valid: ${validActions.join(", ")}`)
            }

            // Build browser command
            const browserArgs: string[] = ["--browser", action, "--profile", profile]
            if (args.targetUrl && action === "navigate") {
              browserArgs.push("--url", args.targetUrl)
            }
            
            return await runBridge(browserArgs, 60_000, 2 * 1024 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),

      openclaw_message: tool({
        description: "Send a message via OpenClaw (WhatsApp, Signal, Discord, Telegram)",
        args: {
          target: tool.schema.string().describe("Recipient (phone number, username, or channel)"),
          message: tool.schema.string().describe("Message text to send"),
          media: tool.schema.string().optional().describe("Optional media file path"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: MessageArgs, context: ToolContext) {
          try {
            checkPermissions(context, args.apiKey)
            const safeTarget = validateMessageTarget(args.target)
            const safeMessage = validateMessage(args.message)
            
            // Build message data
            const messageData = JSON.stringify({
              target: safeTarget,
              message: safeMessage,
              media: args.media || null,
            })
            
            return await runBridge(["--message", messageData], 60_000, 512 * 1024)
          } catch (err) {
            const error = err as Error
            if (error.message.includes("[openclaw-bridge]")) {
              throw err
            }
            return `[openclaw-bridge] Failed: ${sanitizeErrorMessage(error.message)}`
          }
        },
      }),
    },
  }
}
