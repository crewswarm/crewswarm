// Task Queue for Swarm Coordination
// Allows agents to assign tasks to each other

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

const QUEUE_DIR = process.env.TASK_QUEUE_DIR || `${process.env.HOME}/.openclaw/workspace/shared-memory/tasks`

// Ensure queue directory exists
async function ensureQueueDir() {
  if (!existsSync(QUEUE_DIR)) {
    await mkdir(QUEUE_DIR, { recursive: true })
  }
}

interface Task {
  id: string
  title: string
  description: string
  assignee?: string
  status: "pending" | "in_progress" | "done" | "blocked"
  priority: "low" | "medium" | "high" | "critical"
  createdBy: string
  createdAt: number
  updatedAt: number
}

function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

export const TaskQueuePlugin: Plugin = async () => {
  return {
    tool: {
      task_create: tool({
        description: "Create a new task in the swarm task queue",
        args: {
          title: tool.schema.string().describe("Task title"),
          description: tool.schema.string().describe("Task description"),
          assignee: tool.schema.string().optional().describe("Assigned agent (e.g., 'qa', 'builder')"),
          priority: tool.schema.string().optional().describe("Priority: low, medium, high, critical"),
        },
        async execute(args) {
          try {
            await ensureQueueDir()
            
            const task: Task = {
              id: generateId(),
              title: args.title,
              description: args.description,
              assignee: args.assignee,
              status: "pending",
              priority: (args.priority as any) || "medium",
              createdBy: "swarm",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }
            
            const filepath = join(QUEUE_DIR, `${task.id}.json`)
            await writeFile(filepath, JSON.stringify(task, null, 2), "utf-8")
            
            return `[task] Created: ${task.id} - ${task.title}`
          } catch (err) {
            return `[task] Error: ${(err as Error).message}`
          }
        },
      }),

      task_list: tool({
        description: "List all tasks, optionally filtered by status",
        args: {
          status: tool.schema.string().optional().describe("Filter by status: pending, in_progress, done, blocked"),
          assignee: tool.schema.string().optional().describe("Filter by assignee"),
        },
        async execute(args) {
          try {
            await ensureQueueDir()
            const files = await readdir(QUEUE_DIR)
            const tasks: Task[] = []
            
            for (const file of files) {
              if (!file.endsWith(".json")) continue
              const content = await readFile(join(QUEUE_DIR, file), "utf-8")
              tasks.push(JSON.parse(content))
            }
            
            // Filter
            let filtered = tasks
            if (args.status) {
              filtered = filtered.filter(t => t.status === args.status)
            }
            if (args.assignee) {
              filtered = filtered.filter(t => t.assignee === args.assignee)
            }
            
            // Sort by priority
            const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
            filtered.sort((a, b) => priorityOrder[a.priority as keyof typeof priorityOrder] - priorityOrder[b.priority as keyof typeof priorityOrder])
            
            if (filtered.length === 0) {
              return "[task] No tasks found"
            }
            
            return filtered.map(t => `[${t.status}] ${t.priority} - ${t.title} (${t.assignee || "unassigned"})`).join("\n")
          } catch (err) {
            return `[task] Error: ${(err as Error).message}`
          }
        },
      }),

      task_assign: tool({
        description: "Assign or reassign a task to an agent",
        args: {
          taskId: tool.schema.string().describe("Task ID"),
          assignee: tool.schema.string().describe("Agent to assign"),
        },
        async execute(args) {
          try {
            const filepath = join(QUEUE_DIR, `${args.taskId}.json`)
            if (!existsSync(filepath)) {
              return `[task] Task not found: ${args.taskId}`
            }
            
            const content = await readFile(filepath, "utf-8")
            const task: Task = JSON.parse(content)
            task.assignee = args.assignee
            task.updatedAt = Date.now()
            
            await writeFile(filepath, JSON.stringify(task, null, 2), "utf-8")
            return `[task] Assigned ${args.taskId} to ${args.assignee}`
          } catch (err) {
            return `[task] Error: ${(err as Error).message}`
          }
        },
      }),

      task_status: tool({
        description: "Update task status",
        args: {
          taskId: tool.schema.string().describe("Task ID"),
          status: tool.schema.string().describe("Status: pending, in_progress, done, blocked"),
        },
        async execute(args) {
          try {
            const filepath = join(QUEUE_DIR, `${args.taskId}.json`)
            if (!existsSync(filepath)) {
              return `[task] Task not found: ${args.taskId}`
            }
            
            const content = await readFile(filepath, "utf-8")
            const task: Task = JSON.parse(content)
            task.status = args.status as any
            task.updatedAt = Date.now()
            
            await writeFile(filepath, JSON.stringify(task, null, 2), "utf-8")
            return `[task] ${args.taskId} -> ${args.status}`
          } catch (err) {
            return `[task] Error: ${(err as Error).message}`
          }
        },
      }),

      task_take: tool({
        description: "Take the highest priority pending task",
        args: {},
        async execute() {
          try {
            await ensureQueueDir()
            const files = await readdir(QUEUE_DIR)
            const tasks: Task[] = []
            
            for (const file of files) {
              if (!file.endsWith(".json")) continue
              const content = await readFile(join(QUEUE_DIR, file), "utf-8")
              tasks.push(JSON.parse(content))
            }
            
            // Get pending tasks, sort by priority
            const pending = tasks.filter(t => t.status === "pending")
            const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
            pending.sort((a, b) => priorityOrder[a.priority as keyof typeof priorityOrder] - priorityOrder[b.priority as keyof typeof priorityOrder])
            
            if (pending.length === 0) {
              return "[task] No pending tasks"
            }
            
            const task = pending[0]
            task.status = "in_progress"
            task.updatedAt = Date.now()
            
            await writeFile(join(QUEUE_DIR, `${task.id}.json`), JSON.stringify(task, null, 2), "utf-8")
            return `[task] Took: ${task.id} - ${task.title}`
          } catch (err) {
            return `[task] Error: ${(err as Error).message}`
          }
        },
      }),
    },
  }
}
