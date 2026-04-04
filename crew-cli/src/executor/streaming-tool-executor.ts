/**
 * StreamingToolExecutor — Feature 1: Streaming Tool Execution
 *
 * Starts executing tools as soon as a complete tool_use block arrives
 * mid-stream, before the LLM has finished generating. This reduces
 * end-to-end latency by overlapping I/O with token generation.
 */

export interface ToolResult {
  toolId: string;
  toolName: string;
  result: any;
  error?: string;
  durationMs: number;
}

export type ToolExecutorFn = (name: string, args: Record<string, any>) => Promise<any>;

export class StreamingToolExecutor {
  private runningTools: Map<string, Promise<ToolResult>> = new Map();
  private completedTools: Map<string, ToolResult> = new Map();

  constructor(private readonly executeFn: ToolExecutorFn) {}

  /**
   * Called as soon as a complete tool_use block is detected mid-stream.
   * Starts executing the tool immediately without waiting for the stream to end.
   */
  onToolUseComplete(toolId: string, toolName: string, args: Record<string, any>): void {
    if (this.runningTools.has(toolId) || this.completedTools.has(toolId)) return;

    const promise = this._runTool(toolId, toolName, args);
    this.runningTools.set(toolId, promise);

    // Move to completed map when done (fire-and-forget; results collected later)
    promise.then(result => {
      this.completedTools.set(toolId, result);
      this.runningTools.delete(toolId);
    }).catch(() => {
      // Error already captured inside _runTool
      this.runningTools.delete(toolId);
    });
  }

  private async _runTool(toolId: string, toolName: string, args: Record<string, any>): Promise<ToolResult> {
    const start = Date.now();
    try {
      const result = await this.executeFn(toolName, args);
      return { toolId, toolName, result, durationMs: Date.now() - start };
    } catch (err: any) {
      return {
        toolId,
        toolName,
        result: null,
        error: err?.message || String(err),
        durationMs: Date.now() - start
      };
    }
  }

  /**
   * Wait for all in-flight and already-completed tool executions.
   * Call this after the stream ends to collect every result.
   */
  async getRemainingResults(): Promise<ToolResult[]> {
    // Wait for any still-running tools
    const pending = Array.from(this.runningTools.values());
    const settled = await Promise.allSettled(pending);

    // Merge newly-settled into completed map
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        const r = outcome.value;
        this.completedTools.set(r.toolId, r);
      }
    }

    const results = Array.from(this.completedTools.values());
    // Clear state for reuse
    this.completedTools.clear();
    this.runningTools.clear();
    return results;
  }

  /** True when at least one tool is still running */
  get hasPendingTools(): boolean {
    return this.runningTools.size > 0;
  }

  /** Number of tools currently in-flight */
  get pendingCount(): number {
    return this.runningTools.size;
  }
}

// ---------------------------------------------------------------------------
// Streaming helpers that fire tools mid-stream
// ---------------------------------------------------------------------------

/**
 * Stream an OpenAI-compatible response and execute tool calls as soon as
 * each tool_call is complete (signalled by finish_reason === "tool_calls"
 * or when arguments JSON is fully assembled on a per-index basis).
 *
 * Returns the same shape as streamOpenAIResponse but tool execution has
 * already been started by the time this function returns.
 */
export async function streamOpenAIWithEarlyExecution(
  response: Response,
  executor: StreamingToolExecutor,
  onText?: (chunk: string) => void
): Promise<{ text: string; toolCallIds: string[] }> {
  if (!response.body) throw new Error('No response body for streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  // Per-index accumulator: index → { id, name, args }
  const accumulator = new Map<number, { id: string; name: string; args: string; fired: boolean }>();
  const firedIds: string[] = [];

  /**
   * Try to fire a tool call when its arguments appear to be valid JSON.
   * We fire eagerly on each delta rather than waiting for finish_reason,
   * but only if the JSON parses successfully (i.e., it is complete).
   */
  const tryFireToolCall = (idx: number) => {
    const entry = accumulator.get(idx);
    if (!entry || entry.fired || !entry.name) return;
    try {
      const args = JSON.parse(entry.args || '{}');
      entry.fired = true;
      firedIds.push(entry.id);
      executor.onToolUseComplete(entry.id, entry.name, args);
    } catch {
      // JSON not complete yet — wait for more deltas
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk?.choices?.[0]?.delta;
          const finishReason = chunk?.choices?.[0]?.finish_reason;

          if (delta?.content) {
            onText?.(delta.content);
            fullText += delta.content;
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulator.has(idx)) {
                accumulator.set(idx, { id: tc.id || `tc_${idx}_${Date.now()}`, name: '', args: '', fired: false });
              }
              const entry = accumulator.get(idx)!;
              if (tc.id && !entry.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) {
                entry.args += tc.function.arguments;
                // Try to fire after each args delta
                tryFireToolCall(idx);
              }
            }
          }

          // On finish_reason tool_calls, fire any remaining unfired tools
          if (finishReason === 'tool_calls') {
            for (const [idx] of accumulator) {
              tryFireToolCall(idx);
            }
          }
        } catch { /* skip malformed chunks */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Fire any tools that still haven't been fired (e.g., args were malformed JSON mid-stream
  // but we still want to attempt execution with repaired args)
  for (const [, entry] of accumulator) {
    if (!entry.fired && entry.name) {
      let args: Record<string, any> = {};
      try { args = JSON.parse(entry.args || '{}'); } catch { /* use empty args */ }
      entry.fired = true;
      firedIds.push(entry.id);
      executor.onToolUseComplete(entry.id, entry.name, args);
    }
  }

  return { text: fullText, toolCallIds: firedIds };
}

/**
 * Stream an Anthropic response and execute tool calls as soon as each
 * content_block_stop event arrives for a tool_use block.
 */
export async function streamAnthropicWithEarlyExecution(
  response: Response,
  executor: StreamingToolExecutor,
  onText?: (chunk: string) => void
): Promise<{ text: string; toolCallIds: string[] }> {
  if (!response.body) throw new Error('No response body for streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  // index → { id, name, inputJson }
  const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
  const firedIds: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id || `tb_${event.index}_${Date.now()}`,
              name: event.content_block.name || '',
              inputJson: ''
            });
          }

          if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              onText?.(event.delta.text);
              fullText += event.delta.text;
            }
            if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
              const block = toolBlocks.get(event.index);
              if (block) block.inputJson += event.delta.partial_json;
            }
          }

          // Fire tool execution immediately on content_block_stop for tool_use blocks
          if (event.type === 'content_block_stop') {
            const block = toolBlocks.get(event.index);
            if (block && block.name) {
              let args: Record<string, any> = {};
              try { args = JSON.parse(block.inputJson || '{}'); } catch { /* use empty */ }
              firedIds.push(block.id);
              executor.onToolUseComplete(block.id, block.name, args);
            }
          }
        } catch { /* skip malformed events */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: fullText, toolCallIds: firedIds };
}

/**
 * Stream a Gemini response and execute tool calls as soon as each
 * functionCall block is encountered (Gemini sends them complete in one chunk).
 */
export async function streamGeminiWithEarlyExecution(
  response: Response,
  executor: StreamingToolExecutor,
  onText?: (chunk: string) => void
): Promise<{ text: string; toolCallIds: string[] }> {
  if (!response.body) throw new Error('No response body for streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const firedIds: string[] = [];
  let toolSeq = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const chunk = JSON.parse(jsonStr);
          const parts = chunk?.candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (part.text) {
              onText?.(part.text);
              fullText += part.text;
            }
            // Gemini sends complete functionCall blocks in one SSE event
            if (part.functionCall) {
              const toolId = `gemini_tc_${toolSeq++}_${Date.now()}`;
              firedIds.push(toolId);
              executor.onToolUseComplete(
                toolId,
                part.functionCall.name || '',
                part.functionCall.args || {}
              );
            }
          }
        } catch { /* skip malformed events */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: fullText, toolCallIds: firedIds };
}
