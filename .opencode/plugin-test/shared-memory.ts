import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

const MEMORY_BASE_DIR = process.env.SHARED_MEMORY_DIR || `${process.env.HOME}/.openclaw/workspace/shared-memory`
const MEMORY_NAMESPACE = process.env.SHARED_MEMORY_NAMESPACE || "claw-swarm"
const MEMORY_DIR = join(MEMORY_BASE_DIR, MEMORY_NAMESPACE)
const RECORD_DIR = join(MEMORY_DIR, "records")
const DEFAULT_ALLOWED_AGENTS = "main,admin,build,coder,researcher,architect,reviewer"
const ALLOWED_AGENTS = (process.env.OPENCLAW_ALLOWED_AGENTS || DEFAULT_ALLOWED_AGENTS)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const API_KEY = (process.env.OPENCLAW_API_KEY || "").trim()
const REQUIRE_API_KEY = (process.env.OPENCLAW_REQUIRE_API_KEY || "1") !== "0"

interface MemoryRecord {
  key: string
  value: string
  owner: string
  scope: string
  tags: string[]
  createdAt: string
  updatedAt: string
  expiresAt?: string
}

function validateKey(key: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
    throw new Error("[memory] Invalid key. Use 1-80 chars: letters, numbers, dot, underscore, dash")
  }
  return key
}

function validateScope(scope: string): string {
  if (!/^[a-zA-Z0-9._-]{1,40}$/.test(scope)) {
    throw new Error("[memory] Invalid scope. Use 1-40 chars: letters, numbers, dot, underscore, dash")
  }
  return scope
}

function parseTags(raw: string[] | undefined): string[] {
  if (!raw) return []
  const tags = raw
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9._-]{1,24}$/.test(t))
  return [...new Set(tags)]
}

function checkPermissions(context: { agent?: string } | undefined, providedKey?: string): void {
  const agentId = context?.agent || "anonymous"
  if (!ALLOWED_AGENTS.includes(agentId) && !ALLOWED_AGENTS.includes("*")) {
    throw new Error(`[memory] Unauthorized agent: ${agentId}`)
  }
  if (REQUIRE_API_KEY && !API_KEY) {
    throw new Error("[memory] OPENCLAW_API_KEY is required but not configured")
  }
  if (REQUIRE_API_KEY) {
    const key = (providedKey || "").trim()
    if (!key || key !== API_KEY) {
      throw new Error("[memory] Invalid API key")
    }
  }
}

function textPath(key: string): string {
  return join(MEMORY_DIR, `${validateKey(key)}.txt`)
}

function recordPath(key: string): string {
  return join(RECORD_DIR, `${validateKey(key)}.json`)
}

function isExpired(record: MemoryRecord, now = Date.now()): boolean {
  if (!record.expiresAt) return false
  const expires = Date.parse(record.expiresAt)
  return Number.isFinite(expires) && expires <= now
}

async function readRecord(key: string): Promise<MemoryRecord | null> {
  const filepath = recordPath(key)
  if (!existsSync(filepath)) return null
  try {
    const content = await readFile(filepath, "utf-8")
    return JSON.parse(content) as MemoryRecord
  } catch {
    return null
  }
}

async function writeRecord(record: MemoryRecord): Promise<void> {
  await writeFile(recordPath(record.key), JSON.stringify(record, null, 2), "utf-8")
}

async function ensureMemoryDir() {
  if (!existsSync(MEMORY_DIR)) {
    await mkdir(MEMORY_DIR, { recursive: true })
  }
  if (!existsSync(RECORD_DIR)) {
    await mkdir(RECORD_DIR, { recursive: true })
  }
}

export const SharedMemoryPlugin: Plugin = async () => {
  interface AuthArg {
    apiKey?: string
  }
  interface WriteArgs extends AuthArg {
    key: string
    value: string
    append?: boolean
  }
  interface KeyArgs extends AuthArg {
    key: string
  }
  interface PutArgs extends AuthArg {
    key: string
    value: string
    ttlSeconds?: number
    scope?: string
    tags?: string[]
  }
  interface SearchArgs extends AuthArg {
    query?: string
    scope?: string
    tag?: string
    limit?: number
  }
  interface PruneArgs extends AuthArg {
    dryRun?: boolean
  }

  return {
    tool: {
      memory_write: tool({
        description: "Write plain-text shared memory value",
        args: {
          key: tool.schema.string().describe("Memory key (filename)"),
          value: tool.schema.string().describe("Value to store"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
          append: tool.schema.boolean().optional().describe("Append to existing value instead of overwrite"),
        },
        async execute(args: WriteArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()
            const filepath = textPath(args.key)

            let content = args.value
            if (args.append && existsSync(filepath)) {
              const existing = await readFile(filepath, "utf-8")
              content = `${existing}\n${args.value}`
            }

            await writeFile(filepath, content, "utf-8")
            return `[memory] Written to ${args.key} in namespace ${MEMORY_NAMESPACE}`
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_read: tool({
        description: "Read plain-text shared memory value",
        args: {
          key: tool.schema.string().describe("Memory key to read"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: KeyArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()
            const filepath = textPath(args.key)

            if (!existsSync(filepath)) {
              return `[memory] Key "${args.key}" not found`
            }

            return await readFile(filepath, "utf-8")
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_list: tool({
        description: "List all shared memory keys (text + structured)",
        args: {
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: AuthArg, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()
            const files = await readdir(MEMORY_DIR)
            const textKeys = files.filter((f) => f.endsWith(".txt")).map((f) => f.replace(".txt", ""))
            const structuredFiles = await readdir(RECORD_DIR)
            const structuredKeys = structuredFiles
              .filter((f) => f.endsWith(".json"))
              .map((f) => f.replace(".json", ""))

            return JSON.stringify({
              namespace: MEMORY_NAMESPACE,
              textKeys,
              structuredKeys,
            }, null, 2)
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_delete: tool({
        description: "Delete a plain-text shared memory key",
        args: {
          key: tool.schema.string().describe("Memory key to delete"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: KeyArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            const filepath = textPath(args.key)
            if (!existsSync(filepath)) {
              return `[memory] Key "${args.key}" not found`
            }
            await unlink(filepath)
            return `[memory] Deleted ${args.key} from namespace ${MEMORY_NAMESPACE}`
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_put: tool({
        description: "Store structured shared memory with optional TTL/tags/scope",
        args: {
          key: tool.schema.string().describe("Record key"),
          value: tool.schema.string().describe("Record value"),
          ttlSeconds: tool.schema.number().int().positive().optional().describe("Optional time-to-live in seconds"),
          scope: tool.schema.string().optional().describe("Logical scope (default: global)"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: PutArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()

            const key = validateKey(args.key)
            const nowIso = new Date().toISOString()
            const scope = validateScope(args.scope || "global")
            const tags = parseTags(args.tags)
            const owner = context.agent || "anonymous"
            const expiresAt = args.ttlSeconds ? new Date(Date.now() + (args.ttlSeconds * 1000)).toISOString() : undefined

            const existing = await readRecord(key)
            const record: MemoryRecord = {
              key,
              value: args.value,
              owner,
              scope,
              tags,
              createdAt: existing?.createdAt || nowIso,
              updatedAt: nowIso,
              ...(expiresAt ? { expiresAt } : {}),
            }

            await writeRecord(record)
            return `[memory] Stored record ${key} in ${MEMORY_NAMESPACE}/${scope}`
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_get: tool({
        description: "Read structured shared memory record by key",
        args: {
          key: tool.schema.string().describe("Record key"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: KeyArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()
            const key = validateKey(args.key)
            const record = await readRecord(key)
            if (!record) return `[memory] Key "${key}" not found`
            if (isExpired(record)) {
              await unlink(recordPath(key)).catch(() => {})
              return `[memory] Key "${key}" expired`
            }
            return JSON.stringify(record, null, 2)
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_search: tool({
        description: "Search structured shared memory by query/scope/tag",
        args: {
          query: tool.schema.string().optional().describe("Text query against key/value"),
          scope: tool.schema.string().optional().describe("Filter by scope"),
          tag: tool.schema.string().optional().describe("Filter by tag"),
          limit: tool.schema.number().int().positive().max(100).optional().describe("Result limit (default: 20)"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: SearchArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()

            const query = (args.query || "").toLowerCase()
            const scope = args.scope ? validateScope(args.scope) : undefined
            const tag = args.tag ? args.tag.trim().toLowerCase() : undefined
            const limit = args.limit || 20

            const files = await readdir(RECORD_DIR)
            const results: Array<Record<string, string | string[]>> = []

            for (const file of files) {
              if (!file.endsWith(".json")) continue
              const key = file.slice(0, -5)
              const record = await readRecord(key)
              if (!record) continue
              if (isExpired(record)) {
                await unlink(recordPath(key)).catch(() => {})
                continue
              }
              if (scope && record.scope !== scope) continue
              if (tag && !record.tags.includes(tag)) continue
              if (query) {
                const haystack = `${record.key}\n${record.value}`.toLowerCase()
                if (!haystack.includes(query)) continue
              }

              results.push({
                key: record.key,
                scope: record.scope,
                owner: record.owner,
                tags: record.tags,
                updatedAt: record.updatedAt,
                expiresAt: record.expiresAt || "",
                preview: record.value.slice(0, 200),
              })
              if (results.length >= limit) break
            }

            return JSON.stringify({ namespace: MEMORY_NAMESPACE, count: results.length, results }, null, 2)
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),

      memory_prune: tool({
        description: "Delete expired structured shared-memory records",
        args: {
          dryRun: tool.schema.boolean().optional().describe("Only report what would be deleted"),
          apiKey: tool.schema.string().optional().describe("API key when OPENCLAW_REQUIRE_API_KEY=1"),
        },
        async execute(args: PruneArgs, context: { agent?: string }) {
          try {
            checkPermissions(context, args.apiKey)
            await ensureMemoryDir()

            const files = await readdir(RECORD_DIR)
            let scanned = 0
            let removed = 0
            for (const file of files) {
              if (!file.endsWith(".json")) continue
              scanned += 1
              const key = file.slice(0, -5)
              const record = await readRecord(key)
              if (!record || !isExpired(record)) continue
              if (!args.dryRun) {
                await unlink(recordPath(key)).catch(() => {})
              }
              removed += 1
            }

            return `[memory] Prune complete in ${MEMORY_NAMESPACE}: scanned=${scanned}, expired=${removed}, dryRun=${args.dryRun ? "yes" : "no"}`
          } catch (err) {
            return `[memory] Error: ${(err as Error).message}`
          }
        },
      }),
    },
  }
}
