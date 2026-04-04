/**
 * Shared SSE streaming helpers for all LLM providers.
 * Extracts the common pattern from agentic-executor.ts so local.ts
 * and multi-turn-drivers.ts can stream without duplicating logic.
 */

/** Parse an SSE stream from an OpenAI-compatible API (OpenAI, Grok, DeepSeek, Groq, Mistral, Cerebras) */
export async function streamOpenAIResponse(
  response: Response,
  onText?: (chunk: string) => void
): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: string }>; usage?: any; finishReason?: string }> {
  if (!response.body) throw new Error('No response body for streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const toolCallAccumulator = new Map<number, { name: string; args: string }>();
  let usage: any = null;
  let finishReason: string | undefined;

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
          const choice = chunk?.choices?.[0];
          const delta = choice?.delta;

          // Capture finish_reason when present
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          if (!delta) {
            // Capture usage from final chunk
            if (chunk?.usage) usage = chunk.usage;
            continue;
          }

          if (delta.content) {
            onText?.(delta.content);
            fullText += delta.content;
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, { name: '', args: '' });
              }
              const acc = toolCallAccumulator.get(idx)!;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...toolCallAccumulator.values()]
    .filter(tc => tc.name)
    .map(tc => ({ name: tc.name, arguments: tc.args }));

  return { text: fullText, toolCalls, usage, finishReason };
}

/** Parse an SSE stream from Anthropic's Messages API */
export async function streamAnthropicResponse(
  response: Response,
  onText?: (chunk: string) => void
): Promise<{ text: string; toolCalls: Array<{ name: string; input: any }>; usage?: any; stopReason?: string }> {
  if (!response.body) throw new Error('No response body for streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const toolBlocks = new Map<number, { name: string; inputJson: string }>();
  let usage: any = null;
  let stopReason: string | undefined;

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
            toolBlocks.set(event.index, { name: event.content_block.name || '', inputJson: '' });
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

          if (event.type === 'message_delta') {
            if (event.usage) usage = event.usage;
            // Capture stop_reason from message_delta (Anthropic streaming)
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          }
          if (event.type === 'message_start' && event.message?.usage) {
            usage = { ...event.message.usage, ...(usage || {}) };
          }
        } catch { /* skip malformed events */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...toolBlocks.values()]
    .filter(b => b.name)
    .map(b => {
      let input = {};
      try { input = JSON.parse(b.inputJson); } catch { /* partial JSON */ }
      return { name: b.name, input };
    });

  return { text: fullText, toolCalls, usage, stopReason };
}

/** Parse an SSE stream from Gemini's streamGenerateContent endpoint */
export async function streamGeminiResponse(
  response: Response,
  onText?: (chunk: string) => void
): Promise<{ text: string; toolCalls: Array<{ name: string; args: any }>; usage?: any }> {
  if (!response.body) throw new Error('No response body for streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const toolCalls: Array<{ name: string; args: any }> = [];
  let usage: any = null;

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
            if (part.functionCall) {
              toolCalls.push({ name: part.functionCall.name || '', args: part.functionCall.args || {} });
            }
          }
          if (chunk?.usageMetadata) usage = chunk.usageMetadata;
        } catch { /* skip malformed events */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: fullText, toolCalls, usage };
}

/** Default text handler: write to stdout */
export const writeToStdout = (chunk: string) => process.stdout.write(chunk);

/** Check if streaming is disabled via env */
export function isStreamingDisabled(): boolean {
  return String(process.env.CREW_NO_STREAM || '').toLowerCase() === 'true';
}
