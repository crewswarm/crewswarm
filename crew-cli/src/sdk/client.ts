/**
 * Crew CLI SDK (Codebuff Pattern)
 * 
 * Programmatic API for embedding crew-cli in your own applications.
 * 
 * Features:
 * - Event streaming (real-time progress)
 * - Session continuity (previousRun state)
 * - Multi-model fallback
 * - Shared dependencies pattern
 * 
 * Example:
 * ```typescript
 * import { CrewClient } from '@crew/cli/sdk';
 * 
 * const client = new CrewClient({
 *   onProgress: (event) => console.log(event),
 * });
 * 
 * const state1 = await client.run({
 *   task: 'Create calculator.js',
 * });
 * 
 * const state2 = await client.run({
 *   task: 'Add unit tests',
 *   previousRun: state1,  // Session continuity
 * });
 * ```
 */

import { CumulativeDiffSandbox } from '../sandbox/cumulative-diff.js';
import { SharedDepsExecutor } from '../executor/shared-deps.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger();

export interface CrewClientOptions {
  /** Working directory for file operations */
  cwd?: string;
  
  /** Default model to use */
  model?: string;
  
  /** Models to try in fallback order */
  models?: string[];
  
  /** Progress event handler */
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
}

export interface RunOptions {
  /** Task description */
  task: string;
  
  /** Model to use (overrides client default) */
  model?: string;
  
  /** Previous run state for session continuity */
  previousRun?: RunState;
}

export interface RunState {
  /** Sandbox with staged changes */
  sandbox: CumulativeDiffSandbox;
  
  /** Conversation history */
  history: Array<{ role: string; content: string }>;
  
  /** Shared dependencies from last run */
  sharedDeps?: string;
  
  /** Generated file paths */
  filePaths?: string[];
  
  /** Output result */
  output?: any;
}

export type ProgressEvent =
  | { type: 'start'; task: string }
  | { type: 'shared_deps_start' }
  | { type: 'shared_deps_complete'; sharedDeps: string }
  | { type: 'file_paths_start' }
  | { type: 'file_paths_complete'; filePaths: string[] }
  | { type: 'file_generation_start'; filePath: string }
  | { type: 'file_generation_complete'; filePath: string; content: string }
  | { type: 'complete'; output: any }
  | { type: 'error'; message: string; error?: Error };

export class CrewClient {
  private options: Required<CrewClientOptions>;
  private sharedDepsExecutor: SharedDepsExecutor;

  constructor(options: CrewClientOptions = {}) {
    this.options = {
      cwd: options.cwd || process.cwd(),
      model: options.model || this.detectDefaultModel(),
      models: options.models || [
        'gemini-2.5-flash',  // Use working Gemini model
        'grok-beta',
        'deepseek-chat'
      ],
      onProgress: options.onProgress || (() => {}),
    };

    this.sharedDepsExecutor = new SharedDepsExecutor();
  }

  /**
   * Run a task with crew-cli
   * 
   * @param options - Run options
   * @returns Run state (pass to next run for session continuity)
   */
  async run(options: RunOptions): Promise<RunState> {
    const { task, model, previousRun } = options;

    // Emit start event
    await this.emit({ type: 'start', task });

    // Use previous sandbox or create new
    const sandbox = previousRun?.sandbox || new CumulativeDiffSandbox(this.options.cwd);
    await sandbox.load();

    // Build conversation history
    const history = previousRun?.history || [];
    history.push({ role: 'user', content: task });

    try {
      // Execute with shared deps pattern
      await this.emit({ type: 'shared_deps_start' });
      
      const result = await this.sharedDepsExecutor.execute(
        task,
        sandbox,
        { model: model || this.options.model }
      );

      await this.emit({
        type: 'shared_deps_complete',
        sharedDeps: result.sharedDeps
      });

      await this.emit({
        type: 'file_paths_complete',
        filePaths: result.filePaths
      });

      // Save sandbox state
      await sandbox.persist();

      await this.emit({
        type: 'complete',
        output: {
          sharedDeps: result.sharedDeps,
          filePaths: result.filePaths,
          filesGenerated: result.files.size
        }
      });

      return {
        sandbox,
        history,
        sharedDeps: result.sharedDeps,
        filePaths: result.filePaths,
        output: {
          sharedDeps: result.sharedDeps,
          filePaths: result.filePaths,
          filesGenerated: result.files.size
        }
      };

    } catch (err: any) {
      await this.emit({
        type: 'error',
        message: err.message,
        error: err
      });
      throw err;
    }
  }

  /**
   * Emit progress event
   */
  private async emit(event: ProgressEvent): Promise<void> {
    try {
      await this.options.onProgress(event);
    } catch (err) {
      logger.error(`Progress handler error: ${(err as Error).message}`);
    }
  }

  /**
   * Detect default model based on available API keys
   */
  private detectDefaultModel(): string {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      return 'gemini-2.5-flash';  // Use working Gemini model
    }
    if (process.env.XAI_API_KEY) {
      return 'grok-beta';
    }
    if (process.env.DEEPSEEK_API_KEY) {
      return 'deepseek-chat';
    }
    return 'gemini-2.5-flash';  // Default fallback
  }
}
