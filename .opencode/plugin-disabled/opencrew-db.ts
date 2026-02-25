import Database from "bun:sqlite"
import { join } from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

// Task State Machine
type TaskState = 
  | "pending" 
  | "assigned" 
  | "acknowledged" 
  | "running" 
  | "done" 
  | "failed" 
  | "retrying" 
  | "cancelled" 
  | "archived"

type Priority = "low" | "medium" | "high" | "critical"

interface Task {
  id: string
  state: TaskState
  type: string
  title: string
  description?: string
  payload: string
  priority: Priority
  assigned_to?: string
  created_by: string
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
  retry_count: number
  max_retries: number
  correlation_id?: string
  parent_task?: string
  tags?: string
}

interface TaskEvent {
  id: string
  task_id: string
  event: string
  from_state?: string
  to_state?: string
  agent?: string
  payload?: string
  ts: string
}

const DB_DIR = join(process.env.HOME || "", ".openclaw", "workspace", "shared-memory", "claw-swarm", "db")
const DB_PATH = join(DB_DIR, "opencrew.db")

class TaskQueue {
  private db: Database

  constructor() {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.initSchema()
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'pending',
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        priority TEXT NOT NULL DEFAULT 'medium',
        assigned_to TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        correlation_id TEXT,
        parent_task TEXT,
        tags TEXT,
        lease_expires_at TEXT,
        heartbeat_interval INTEGER DEFAULT 30,
        idempotency_key TEXT UNIQUE,
        FOREIGN KEY (parent_task) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        agent TEXT,
        payload TEXT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON task_events(ts);

      CREATE TABLE IF NOT EXISTS agent_health (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'unknown',
        last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
        tasks_completed INTEGER DEFAULT 0,
        tasks_failed INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        cpu_percent REAL,
        memory_mb REAL,
        version TEXT
      );

      CREATE TABLE IF NOT EXISTS queue_metrics (
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        labels TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_name ON queue_metrics(metric_name);
      CREATE INDEX IF NOT EXISTS idx_metrics_ts ON queue_metrics(ts);
    `)
  }

  createTask(task: Omit<Task, "id" | "created_at" | "updated_at" | "retry_count">): Task {
    const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const now = new Date().toISOString()
    
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, state, type, title, description, payload, priority, 
        assigned_to, created_by, created_at, updated_at, max_retries, 
        correlation_id, parent_task, tags)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    stmt.run(id, task.type, task.title, task.description || '', task.payload, 
      task.priority, task.assigned_to || null, task.created_by, now, now,
      task.max_retries || 3, task.correlation_id || null, 
      task.parent_task || null, task.tags || null)
    
    this.logEvent(id, "created", null, "pending", task.created_by)
    return this.getTask(id)!
  }

  getTask(id: string): Task | null {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE id = ?")
    return stmt.get(id) as Task | null
  }

  claimTask(agentId: string, taskTypes: string[] = []): Task | null {
    const typesStr = taskTypes.length > 0 ? 
      `AND type IN (${taskTypes.map(() => '?').join(',')})` : ''
    
    const query = `
      SELECT * FROM tasks 
      WHERE state = 'pending' ${typesStr}
      ORDER BY 
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'medium' THEN 3 
          WHEN 'low' THEN 4 
        END,
        created_at ASC
      LIMIT 1
    `
    
    const stmt = this.db.prepare(query)
    const task = stmt.get(...(taskTypes.length > 0 ? taskTypes : [])) as Task | null
    
    if (task) {
      this.transition(task.id, "assigned", agentId)
    }
    return task
  }

  transition(taskId: string, toState: TaskState, agent?: string, payload?: string): boolean {
    const task = this.getTask(taskId)
    if (!task) return false

    const fromState = task.state
    
    const validTransitions: Record<TaskState, TaskState[]> = {
      pending: ["assigned", "cancelled"],
      assigned: ["acknowledged", "assigned", "cancelled"],
      acknowledged: ["running", "cancelled"],
      running: ["done", "failed", "cancelled"],
      failed: ["retrying", "archived", "cancelled"],
      retrying: ["pending", "archived"],
      done: ["archived"],
      cancelled: ["archived"],
      archived: []
    }

    if (!validTransitions[fromState]?.includes(toState)) {
      throw new Error(`Invalid transition: ${fromState} -> ${toState}`)
    }

    const now = new Date().toISOString()
    const updates: string[] = [`state = ?`, `updated_at = ?`]
    const values: any[] = [toState, now]

    if (toState === "running") {
      updates.push("started_at = ?")
      values.push(now)
    }
    if (["done", "failed", "cancelled", "archived"].includes(toState)) {
      updates.push("completed_at = ?")
      values.push(now)
    }
    if (agent) {
      updates.push("assigned_to = ?")
      values.push(agent)
    }

    values.push(taskId)

    const stmt = this.db.prepare(`
      UPDATE tasks SET ${updates.join(', ')} WHERE id = ?
    `)
    stmt.run(...values)

    this.logEvent(taskId, `transition:${toState}`, fromState, toState, agent, payload)
    
    if (agent && (toState === "done" || toState === "failed")) {
      this.updateAgentStats(agent, toState)
    }

    return true
  }

  private logEvent(taskId: string, event: string, fromState?: string, 
    toState?: string, agent?: string, payload?: string) {
    const id = `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const stmt = this.db.prepare(`
      INSERT INTO task_events (id, task_id, event, from_state, to_state, agent, payload, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    stmt.run(id, taskId, event, fromState || null, toState || null, agent || null, payload || null)
  }

  // HEARTBEAT: Renew lease for running task
  heartbeat(taskId: string, agent: string, leaseSeconds: number = 60): boolean {
    const task = this.getTask(taskId)
    if (!task || task.assigned_to !== agent) return false
    if (task.state !== "running") return false
    
    const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString()
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET lease_expires_at = ?, updated_at = datetime('now')
      WHERE id = ? AND assigned_to = ?
    `)
    const result = stmt.run(expires, taskId, agent)
    
    if (result.changes > 0) {
      this.logEvent(taskId, "heartbeat", task.state, task.state, agent, JSON.stringify({ leaseSeconds }))
      return true
    }
    return false
  }

  // RECLAIM: Move expired leases back to pending
  reclaimExpired(): number {
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET state = 'pending', assigned_to = NULL, lease_expires_at = NULL, updated_at = datetime('now')
      WHERE state IN ('assigned', 'acknowledged', 'running')
      AND lease_expires_at IS NOT NULL
      AND datetime(lease_expires_at) < datetime('now')
    `)
    const result = stmt.run()
    const count = result.changes || 0
    
    if (count > 0) {
      this.logEvent("system", "reclaim_expired", null, null, "system", JSON.stringify({ count }))
    }
    return count
  }

  // CLAIM WITH LEASE: Claim task and set expiry
  claimTaskWithLease(agentId: string, leaseSeconds: number = 60, taskTypes: string[] = []): Task | null {
    // First reclaim any expired
    this.reclaimExpired()
    
    const typesStr = taskTypes.length > 0 ? 
      `AND type IN (${taskTypes.map(() => '?').join(',')})` : ''
    
    const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString()
    
    // Atomic claim: pending → assigned with lease
    const query = `
      SELECT * FROM tasks 
      WHERE state = 'pending' ${typesStr}
      ORDER BY 
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'medium' THEN 3 
          WHEN 'low' THEN 4 
        END,
        created_at ASC
      LIMIT 1
    `
    
    const stmt = this.db.prepare(query)
    const task = stmt.get(...(taskTypes.length > 0 ? taskTypes : [])) as Task | null
    
    if (task) {
      const update = this.db.prepare(`
        UPDATE tasks 
        SET state = 'assigned', assigned_to = ?, lease_expires_at = ?, updated_at = datetime('now')
        WHERE id = ? AND state = 'pending'
      `)
      const result = update.run(agentId, expires, task.id)
      
      if (result.changes > 0) {
        this.logEvent(task.id, "assigned_with_lease", "pending", "assigned", agentId, JSON.stringify({ leaseSeconds }))
        return this.getTask(task.id)
      }
    }
    return null
  }

  // IDEMPOTENCY: Check if task already completed (prevent duplicate exec)
  isCompleted(idempotencyKey: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM tasks 
      WHERE idempotency_key = ? AND state IN ('done', 'archived')
    `)
    return !!stmt.get(idempotencyKey)
  }

  private updateAgentStats(agent: string, outcome: "done" | "failed") {
    const completed = outcome === "done" ? 1 : 0
    const failed = outcome === "failed" ? 1 : 0
    const stmt = this.db.prepare(`
      INSERT INTO agent_health (agent_id, state, tasks_completed, tasks_failed, consecutive_failures, last_heartbeat)
      VALUES (?, 'healthy', ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        tasks_completed = tasks_completed + ?,
        tasks_failed = tasks_failed + ?,
        consecutive_failures = CASE WHEN ? = 1 THEN consecutive_failures + 1 ELSE 0 END,
        last_heartbeat = datetime('now'),
        state = CASE WHEN consecutive_failures > 3 THEN 'degraded' ELSE 'healthy' END
    `)
    stmt.run(agent, completed, failed, failed, completed, failed, failed)
  }

  getQueueHealth(): { pending: number; running: number; assigned: number; failed: number; done: number; degraded_agents: number } {
    const counts = this.db.query(`
      SELECT state, COUNT(*) as count FROM tasks WHERE state NOT IN ('archived', 'cancelled') GROUP BY state
    `).all() as Array<{ state: string; count: number }>
    
    const health = { pending: 0, running: 0, assigned: 0, failed: 0, done: 0, degraded_agents: 0 }
    for (const row of counts) {
      if (row.state in health) (health as any)[row.state] = row.count
    }
    
    const degraded = this.db.query(`SELECT COUNT(*) as count FROM agent_health WHERE state = 'degraded'`).get() as { count: number }
    health.degraded_agents = degraded.count
    
    return health
  }

  getTasksForAgent(agentId: string, limit: number = 10): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE assigned_to = ? 
      ORDER BY updated_at DESC 
      LIMIT ?
    `)
    return stmt.all(agentId, limit) as Task[]
  }

  getMetrics(): Record<string, number> {
    const metrics = this.db.query(`
      SELECT 
        COUNT(*) as total_tasks,
        SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN started_at IS NOT NULL THEN 
          (julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 
          ELSE NULL 
        END) as avg_duration_sec
      FROM tasks 
      WHERE created_at > datetime('now', '-1 hour')
    `).get() as Record<string, number | null>
    
    return {
      total_tasks: Number(metrics.total_tasks) || 0,
      pending: Number(metrics.pending) || 0,
      running: Number(metrics.running) || 0,
      done: Number(metrics.done) || 0,
      failed: Number(metrics.failed) || 0,
      avg_duration_sec: Math.round(Number(metrics.avg_duration_sec) || 0)
    }
  }

  close() {
    this.db.close()
  }
}

// Singleton instance
let queueInstance: TaskQueue | null = null
function getQueue(): TaskQueue {
  if (!queueInstance) queueInstance = new TaskQueue()
  return queueInstance
}

export const OpenCrewDBPlugin: Plugin = async () => {
  const queue = getQueue()
  
  interface TaskCreateArgs {
    type: string
    title: string
    description?: string
    payload?: string
    priority?: "low" | "medium" | "high" | "critical"
    assigned_to?: string
    created_by: string
    correlation_id?: string
    tags?: string
    max_retries?: number
    apiKey?: string
  }
  
  interface TaskClaimArgs {
    agent: string
    taskTypes?: string
    apiKey?: string
  }
  
  interface TaskTransitionArgs {
    taskId: string
    toState: "assigned" | "acknowledged" | "running" | "done" | "failed" | "retrying" | "cancelled" | "archived"
    agent?: string
    payload?: string
    apiKey?: string
  }
  
  return {
    tool: {
      task_create: tool({
        description: "Create a new task in the SQLite-backed queue",
        args: {
          type: tool.schema.string().describe("Task type (e.g., coding, review, build)"),
          title: tool.schema.string().describe("Task title"),
          description: tool.schema.string().optional().describe("Task description"),
          payload: tool.schema.string().optional().describe("JSON payload"),
          priority: tool.schema.enum(["low", "medium", "high", "critical"]).optional().describe("Task priority"),
          assigned_to: tool.schema.string().optional().describe("Agent to assign (null = auto-assign)"),
          created_by: tool.schema.string().describe("Creator identifier"),
          correlation_id: tool.schema.string().optional().describe("Correlation ID for tracing"),
          tags: tool.schema.string().optional().describe("Comma-separated tags"),
          max_retries: tool.schema.number().optional().describe("Max retry attempts"),
        },
        async execute(args: TaskCreateArgs) {
          const task = queue.createTask({
            type: args.type,
            title: args.title,
            description: args.description,
            payload: args.payload || "{}",
            priority: args.priority || "medium",
            assigned_to: args.assigned_to,
            created_by: args.created_by,
            correlation_id: args.correlation_id,
            tags: args.tags,
            max_retries: args.max_retries || 3,
          })
          return JSON.stringify({ ok: true, task })
        },
      }),
      
      task_claim: tool({
        description: "Claim next available task for an agent",
        args: {
          agent: tool.schema.string().describe("Agent ID claiming the task"),
          taskTypes: tool.schema.string().optional().describe("Comma-separated task types to filter"),
        },
        async execute(args: TaskClaimArgs) {
          const types = args.taskTypes ? args.taskTypes.split(",").map(t => t.trim()) : []
          const task = queue.claimTask(args.agent, types)
          if (!task) {
            return JSON.stringify({ ok: false, message: "No tasks available" })
          }
          return JSON.stringify({ ok: true, task })
        },
      }),
      
      task_transition: tool({
        description: "Transition task to new state",
        args: {
          taskId: tool.schema.string().describe("Task ID"),
          toState: tool.schema.enum(["assigned", "acknowledged", "running", "done", "failed", "retrying", "cancelled", "archived"]).describe("New state"),
          agent: tool.schema.string().optional().describe("Agent making the transition"),
          payload: tool.schema.string().optional().describe("Additional payload/context"),
        },
        async execute(args: TaskTransitionArgs) {
          try {
            const success = queue.transition(args.taskId, args.toState, args.agent, args.payload)
            return JSON.stringify({ ok: success, taskId: args.taskId, state: args.toState })
          } catch (err) {
            return JSON.stringify({ ok: false, error: (err as Error).message })
          }
        },
      }),
      
      task_health: tool({
        description: "Get queue health metrics",
        args: {},
        async execute() {
          const health = queue.getQueueHealth()
          const metrics = queue.getMetrics()
          return JSON.stringify({ ok: true, health, metrics, timestamp: new Date().toISOString() })
        },
      }),
      
      task_get: tool({
        description: "Get task by ID",
        args: {
          taskId: tool.schema.string().describe("Task ID"),
        },
        async execute(args: { taskId: string }) {
          const task = queue.getTask(args.taskId)
          if (!task) return JSON.stringify({ ok: false, message: "Task not found" })
          return JSON.stringify({ ok: true, task })
        },
      }),
      
      task_claim_lease: tool({
        description: "Claim next available task WITH LEASE (prevents other agents from claiming)",
        args: {
          agent: tool.schema.string().describe("Agent ID claiming the task"),
          taskTypes: tool.schema.string().optional().describe("Comma-separated task types to filter"),
          leaseSeconds: tool.schema.number().optional().describe("Lease duration in seconds (default: 60)"),
        },
        async execute(args: TaskClaimArgs & { leaseSeconds?: number }) {
          const types = args.taskTypes ? args.taskTypes.split(",").map(t => t.trim()) : []
          const task = queue.claimTaskWithLease(args.agent, args.leaseSeconds || 60, types)
          if (!task) {
            return JSON.stringify({ ok: false, message: "No tasks available" })
          }
          return JSON.stringify({ ok: true, task, leaseExpires: task.lease_expires_at })
        },
      }),
      
      task_heartbeat: tool({
        description: "Renew lease for running task (prevents reclaim)",
        args: {
          taskId: tool.schema.string().describe("Task ID"),
          agent: tool.schema.string().describe("Agent ID"),
          leaseSeconds: tool.schema.number().optional().describe("Lease extension in seconds (default: 60)"),
        },
        async execute(args: { taskId: string; agent: string; leaseSeconds?: number }) {
          const success = queue.heartbeat(args.taskId, args.agent, args.leaseSeconds)
          return JSON.stringify({ ok: success, taskId: args.taskId, timestamp: new Date().toISOString() })
        },
      }),
      
      task_reclaim: tool({
        description: "Reclaim expired leases (returns to pending)",
        args: {},
        async execute() {
          const count = queue.reclaimExpired()
          return JSON.stringify({ ok: true, reclaimed: count, timestamp: new Date().toISOString() })
        },
      }),
    },
  }
}

export default OpenCrewDBPlugin