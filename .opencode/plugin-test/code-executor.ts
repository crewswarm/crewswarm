import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile, access } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

type ToolContext = {
  agent?: string
}

const execFileAsync = promisify(execFile)

// Strict output schema for coding tasks (plain JS validation, no zod)
interface FileChange {
  path: string
  action: "created" | "modified" | "deleted"
  lines_added?: number
  lines_removed?: number
}

interface TestResult {
  name: string
  passed: boolean
  output?: string
}

interface CodeTaskResult {
  files_changed: FileChange[]
  tests_run: TestResult[]
  result: "success" | "partial" | "failed"
  summary: string
  errors?: string[]
}

// Environment and paths
const SWARM_DIR = process.env.SWARM_DIR || `${process.env.HOME}/swarm`
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode"
const TASK_LOG_DIR = join(SWARM_DIR, ".opencode", "task-logs")

// In-memory task registry
const activeTasks = new Map<string, {
  id: string
  agent: string
  startedAt: string
  status: "pending" | "running" | "completed" | "failed"
  result?: CodeTaskResult
  output?: string
  error?: string
}>()

async function ensureTaskLogDir(): Promise<void> {
  if (!existsSync(TASK_LOG_DIR)) {
    await mkdir(TASK_LOG_DIR, { recursive: true })
  }
}

function validateTaskPayload(payload: unknown): { instruction: string; files?: string[]; tests?: string[] } {
  if (!payload || typeof payload !== "object") {
    throw new Error("[code-executor] Task payload must be an object")
  }
  const p = payload as Record<string, unknown>
  if (!p.instruction || typeof p.instruction !== "string") {
    throw new Error("[code-executor] Task payload must have 'instruction' string field")
  }
  return {
    instruction: p.instruction,
    files: Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === "string") : undefined,
    tests: Array.isArray(p.tests) ? p.tests.filter((t): t is string => typeof t === "string") : undefined,
  }
}

function buildStrictPrompt(instruction: string, files?: string[], tests?: string[]): string {
  return `You are a code execution agent. Your ONLY job is to write code and return structured results.

## CRITICAL RULES
1. DO NOT return chat text or explanations
2. You MUST use write/edit tools to actually modify files
3. Your final output MUST be valid JSON matching the exact schema below
4. If you cannot complete the task, return result: "failed" with errors array

## TASK
${instruction}

${files ? `## TARGET FILES\n${files.map(f => `- ${f}`).join("\n")}` : ""}
${tests ? `## TESTS TO RUN\n${tests.map(t => `- ${t}`).join("\n")}` : ""}

## REQUIRED OUTPUT FORMAT
You MUST end your response with this exact JSON structure (no markdown, no code blocks, just JSON):

{
  "files_changed": [
    {
      "path": "relative/path/to/file",
      "action": "created|modified|deleted",
      "lines_added": 10,
      "lines_removed": 5
    }
  ],
  "tests_run": [
    {
      "name": "test-name",
      "passed": true,
      "output": "test output or error"
    }
  ],
  "result": "success|partial|failed",
  "summary": "Brief description of what was done",
  "errors": ["any error messages"]
}

## VALIDATION
- If files_changed is empty → result MUST be "failed"
- If tests are specified but not run → result MUST be "partial" or "failed"
- Return ONLY the JSON object, nothing else before or after`
}

function parseJsonOutput(output: string): unknown {
  // Try to find JSON in the output (it might be surrounded by other text)
  const jsonMatch = output.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return null
  }
}

async function executeOpencodeRun(
  prompt: string,
  agent: string,
  timeoutMs: number = 300000
): Promise<{ output: string; exitCode: number }> {
  const taskId = randomUUID()
  const logFile = join(TASK_LOG_DIR, `${taskId}.log`)
  
  // Create temporary prompt file
  const promptFile = join(TASK_LOG_DIR, `${taskId}.prompt`)
  await writeFile(promptFile, prompt, "utf8")
  
  // Execute opencode run with sanitized environment
  const env = {
    ...process.env,
    // Strip desktop server vars to avoid conflicts
    OPENCODE_SERVER_USERNAME: undefined,
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_CLIENT: undefined,
    OPENCODE: undefined,
    // Set agent context
    OPENCODE_AGENT: agent,
    OPENCODE_TASK_ID: taskId,
  }
  
  const startTime = Date.now()
  
  try {
    // Read prompt from file and pass directly to opencode
    const promptContent = await readFile(promptFile, "utf8")
    const { stdout, stderr } = await execFileAsync(
      OPENCODE_BIN,
      ["run", "--format", "json", promptContent],
      {
        cwd: SWARM_DIR,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024, // 50MB
        env: env as NodeJS.ProcessEnv,
      }
    )
    
    const output = stdout || stderr || ""
    const duration = Date.now() - startTime
    
    // Log the execution
    await appendFile(logFile, JSON.stringify({
      taskId,
      agent,
      startedAt: new Date(startTime).toISOString(),
      durationMs: duration,
      output: output.slice(0, 10000), // Limit log size
      exitCode: 0,
    }) + "\n", "utf8")
    
    return { output, exitCode: 0 }
  } catch (error) {
    const err = error as Error & { code?: number; stdout?: string; stderr?: string }
    const output = err.stdout || err.stderr || err.message || ""
    const duration = Date.now() - startTime
    
    await appendFile(logFile, JSON.stringify({
      taskId,
      agent,
      startedAt: new Date(startTime).toISOString(),
      durationMs: duration,
      output: output.slice(0, 10000),
      exitCode: err.code || 1,
      error: err.message,
    }) + "\n", "utf8")
    
    return { output, exitCode: err.code || 1 }
  } finally {
    // Cleanup prompt file
    try {
      await access(promptFile)
      await execFileAsync("rm", [promptFile])
    } catch {}
  }
}

function validateResult(result: unknown): CodeTaskResult {
  if (!result || typeof result !== "object") {
    throw new Error("[code-executor] Output validation failed: result must be an object")
  }
  
  const r = result as Record<string, unknown>
  
  // Validate files_changed
  if (!Array.isArray(r.files_changed)) {
    throw new Error("[code-executor] Output validation failed: files_changed must be an array")
  }
  for (const file of r.files_changed) {
    if (!file || typeof file !== "object") {
      throw new Error("[code-executor] Output validation failed: each file in files_changed must be an object")
    }
    const f = file as Record<string, unknown>
    if (typeof f.path !== "string") {
      throw new Error("[code-executor] Output validation failed: file.path must be a string")
    }
    if (!["created", "modified", "deleted"].includes(String(f.action))) {
      throw new Error("[code-executor] Output validation failed: file.action must be created|modified|deleted")
    }
  }
  
  // Validate tests_run
  if (!Array.isArray(r.tests_run)) {
    throw new Error("[code-executor] Output validation failed: tests_run must be an array")
  }
  for (const test of r.tests_run) {
    if (!test || typeof test !== "object") {
      throw new Error("[code-executor] Output validation failed: each test in tests_run must be an object")
    }
    const t = test as Record<string, unknown>
    if (typeof t.name !== "string") {
      throw new Error("[code-executor] Output validation failed: test.name must be a string")
    }
    if (typeof t.passed !== "boolean") {
      throw new Error("[code-executor] Output validation failed: test.passed must be a boolean")
    }
  }
  
  // Validate result
  if (!["success", "partial", "failed"].includes(String(r.result))) {
    throw new Error("[code-executor] Output validation failed: result must be success|partial|failed")
  }
  
  // Validate summary
  if (typeof r.summary !== "string") {
    throw new Error("[code-executor] Output validation failed: summary must be a string")
  }
  
  return result as CodeTaskResult
}

export const CodeExecutorPlugin: Plugin = async () => {
  await ensureTaskLogDir()
  
  interface ExecuteArgs {
    taskId: string
    instruction: string
    files?: string[]
    tests?: string[]
    agent?: string
    timeout?: number
  }
  
  interface ValidateArgs {
    taskId: string
    expectedFiles?: string[]
    requireTests?: boolean
  }
  
  interface StatusArgs {
    taskId?: string
    agent?: string
  }
  
  return {
    tool: {
      code_execute: tool({
        description: "Execute a coding task through opencode run with strict output validation. Returns structured result with files_changed, tests_run, and status.",
        args: {
          taskId: tool.schema.string().describe("Unique task identifier"),
          instruction: tool.schema.string().describe("The coding instruction/prompt"),
          files: tool.schema.array(tool.schema.string()).optional().describe("Expected files to modify/create"),
          tests: tool.schema.array(tool.schema.string()).optional().describe("Tests that should be run"),
          agent: tool.schema.string().optional().describe("Agent persona to use (coder, fixer, etc)"),
          timeout: tool.schema.number().int().optional().describe("Timeout in seconds (default: 300)"),
        },
        async execute(args: ExecuteArgs, context: ToolContext) {
          const agentId = context?.agent || args.agent || "coder"
          
          try {
            // Register task
            activeTasks.set(args.taskId, {
              id: args.taskId,
              agent: agentId,
              startedAt: new Date().toISOString(),
              status: "running",
            })
            
            // Build strict prompt
            const prompt = buildStrictPrompt(args.instruction, args.files, args.tests)
            
            // Execute
            const timeoutMs = Math.min((args.timeout || 300) * 1000, 600000) // Max 10 min
            const { output, exitCode } = await executeOpencodeRun(prompt, agentId, timeoutMs)
            
            // Parse result
            const parsedResult = parseJsonOutput(output)
            
            if (!parsedResult) {
              activeTasks.set(args.taskId, {
                ...activeTasks.get(args.taskId)!,
                status: "failed",
                error: "No valid JSON output found in response",
                output: output.slice(0, 5000),
              })
              return JSON.stringify({
                ok: false,
                taskId: args.taskId,
                error: "No valid JSON output found. Agent returned chat text instead of structured result.",
                hint: "The agent must use write/edit tools and return JSON schema with files_changed, tests_run, result",
                rawOutput: output.slice(0, 2000),
              }, null, 2)
            }
            
            // Validate against schema
            let validatedResult: CodeTaskResult
            try {
              validatedResult = validateResult(parsedResult)
            } catch (validationError) {
              activeTasks.set(args.taskId, {
                ...activeTasks.get(args.taskId)!,
                status: "failed",
                error: (validationError as Error).message,
                output: output.slice(0, 5000),
              })
              return JSON.stringify({
                ok: false,
                taskId: args.taskId,
                error: (validationError as Error).message,
                rawOutput: output.slice(0, 2000),
              }, null, 2)
            }
            
            // Update task registry
            activeTasks.set(args.taskId, {
              ...activeTasks.get(args.taskId)!,
              status: validatedResult.result === "success" ? "completed" : "failed",
              result: validatedResult,
              output: output.slice(0, 5000),
            })
            
            return JSON.stringify({
              ok: validatedResult.result === "success",
              taskId: args.taskId,
              result: validatedResult,
              exitCode,
            }, null, 2)
            
          } catch (error) {
            const errMsg = (error as Error).message
            activeTasks.set(args.taskId, {
              ...activeTasks.get(args.taskId)!,
              status: "failed",
              error: errMsg,
            })
            return JSON.stringify({
              ok: false,
              taskId: args.taskId,
              error: errMsg,
            }, null, 2)
          }
        },
      }),
      
      code_validate: tool({
        description: "Validate that a completed task actually produced the expected code artifacts",
        args: {
          taskId: tool.schema.string().describe("Task identifier to validate"),
          expectedFiles: tool.schema.array(tool.schema.string()).optional().describe("Files that should exist"),
          requireTests: tool.schema.boolean().optional().describe("Require that tests were run"),
        },
        async execute(args: ValidateArgs, context: ToolContext) {
          const task = activeTasks.get(args.taskId)
          
          if (!task) {
            return JSON.stringify({
              ok: false,
              taskId: args.taskId,
              error: "Task not found",
            }, null, 2)
          }
          
          if (task.status !== "completed") {
            return JSON.stringify({
              ok: false,
              taskId: args.taskId,
              status: task.status,
              error: task.error || "Task not completed",
            }, null, 2)
          }
          
          const validations: string[] = []
          let allPassed = true
          
          // Validate files exist
          if (args.expectedFiles && task.result) {
            for (const expectedFile of args.expectedFiles) {
              const wasChanged = task.result.files_changed.some(
                f => f.path === expectedFile || f.path.endsWith(expectedFile)
              )
              if (!wasChanged) {
                validations.push(`❌ Expected file not in files_changed: ${expectedFile}`)
                allPassed = false
              } else {
                validations.push(`✅ File reported as changed: ${expectedFile}`)
              }
              
              // Check file actually exists
              const fullPath = resolve(SWARM_DIR, expectedFile)
              try {
                await access(fullPath)
                validations.push(`✅ File exists on disk: ${expectedFile}`)
              } catch {
                validations.push(`❌ File does not exist on disk: ${expectedFile}`)
                allPassed = false
              }
            }
          }
          
          // Validate tests were run
          if (args.requireTests && task.result) {
            if (!task.result.tests_run || task.result.tests_run.length === 0) {
              validations.push("❌ No tests were run but tests were required")
              allPassed = false
            } else {
              const passed = task.result.tests_run.filter(t => t.passed).length
              const total = task.result.tests_run.length
              validations.push(`✅ Tests run: ${passed}/${total} passed`)
              
              if (passed < total) {
                validations.push("⚠️ Some tests failed")
              }
            }
          }
          
          return JSON.stringify({
            ok: allPassed,
            taskId: args.taskId,
            validations,
            result: task.result,
          }, null, 2)
        },
      }),
      
      code_status: tool({
        description: "Get status of coding tasks",
        args: {
          taskId: tool.schema.string().optional().describe("Specific task ID (omit for all)"),
          agent: tool.schema.string().optional().describe("Filter by agent"),
        },
        async execute(args: StatusArgs, context: ToolContext) {
          let tasks = Array.from(activeTasks.values())
          
          if (args.taskId) {
            const task = activeTasks.get(args.taskId)
            if (!task) {
              return JSON.stringify({ ok: false, error: "Task not found" }, null, 2)
            }
            return JSON.stringify({ ok: true, task }, null, 2)
          }
          
          if (args.agent) {
            tasks = tasks.filter(t => t.agent === args.agent)
          }
          
          return JSON.stringify({
            ok: true,
            count: tasks.length,
            tasks: tasks.map(t => ({
              id: t.id,
              agent: t.agent,
              status: t.status,
              startedAt: t.startedAt,
              hasResult: !!t.result,
            })),
          }, null, 2)
        },
      }),
    },
  }
}

export default CodeExecutorPlugin
