// @ts-nocheck
import { AgentRouter } from '../agent/router.js';
import { Sandbox } from '../sandbox/index.js';
import { Logger } from '../utils/logger.js';
import type { Orchestrator } from './index.js';
import { AgentKeeper } from '../memory/agentkeeper.js';

export interface WorkerTask {
  id: string;
  agent: string;
  prompt: string;
  context?: string;
  retries?: number;
}

export interface WorkerPoolOptions {
  router: AgentRouter;
  orchestrator: Orchestrator;
  sandbox: Sandbox;
  keeper?: AgentKeeper;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  result?: any;
  error?: string;
  edits?: string[];
}

export class WorkerPool {
  private queue: WorkerTask[] = [];
  private activeWorkers = 0;
  private concurrency: number;
  private maxRetries: number;
  private timeoutMs: number;
  private logger = new Logger();

  constructor(private options: WorkerPoolOptions) {
    this.concurrency = options.concurrency || 3;
    this.maxRetries = options.maxRetries || 2;
    this.timeoutMs = options.timeoutMs || 120000;
  }

  public enqueue(task: WorkerTask) {
    this.queue.push({
      ...task,
      retries: task.retries || 0
    });
  }

  public enqueueAll(tasks: WorkerTask[]) {
    for (const t of tasks) {
      this.enqueue(t);
    }
  }

  public async runAll(options: { sessionId: string; projectDir: string; runId?: string }): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    
    return new Promise((resolve) => {
      const checkQueue = async () => {
        if (this.queue.length === 0 && this.activeWorkers === 0) {
          resolve(results);
          return;
        }

        while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
          const task = this.queue.shift();
          if (!task) continue;

          this.activeWorkers++;
          
          this.executeTask(task, options)
            .then((result) => {
              results.push(result);
              this.activeWorkers--;
              checkQueue();
            })
            .catch((err) => {
              this.logger.error(`Worker pool critical failure for task ${task.id}: ${err.message}`);
              results.push({ taskId: task.id, success: false, error: err.message });
              this.activeWorkers--;
              checkQueue();
            });
        }
      };

      checkQueue();
    });
  }

  private async executeTask(task: WorkerTask, options: { sessionId: string; projectDir: string; runId?: string }): Promise<TaskResult> {
    this.logger.info(`[WorkerPool] Starting task: ${task.id} with agent ${task.agent}`);
    
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
        });

        const fullPrompt = task.context ? `${task.prompt}

${task.context}` : task.prompt;

        const dispatchPromise = this.options.router.dispatch(task.agent, fullPrompt, {
          sessionId: options.sessionId,
          project: options.projectDir,
          timeout: this.timeoutMs.toString()
        });

        const result = await Promise.race([dispatchPromise, timeoutPromise]) as any;

        const responseText = String(result.result || '');
        const edits = await this.options.orchestrator.parseAndApplyToSandbox(responseText);
        if (this.options.keeper && responseText.trim().length > 0) {
          const saved = await this.options.keeper.recordSafe({
            runId: options.runId || 'worker-run',
            tier: 'worker',
            task: task.prompt,
            result: responseText,
            agent: task.agent,
            metadata: {
              taskId: task.id,
              edits: edits.length,
              retries: attempt
            }
          });
          if (!saved.ok) {
            this.logger.warn(`[WorkerPool] Memory write skipped for task ${task.id}: ${saved.error}`);
          }
        }

        this.logger.success(`[WorkerPool] Task completed: ${task.id}`);
        return {
          taskId: task.id,
          success: true,
          result: responseText,
          edits
        };

      } catch (err) {
        attempt++;
        this.logger.warn(`[WorkerPool] Task ${task.id} failed (attempt ${attempt}/${this.maxRetries + 1}): ${(err as Error).message}`);
        
        if (attempt > this.maxRetries) {
          return {
            taskId: task.id,
            success: false,
            error: err.message
          };
        }
        
        // Wait before retry
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    
    return { taskId: task.id, success: false, error: 'Max retries exceeded' };
  }
}
