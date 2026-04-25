/**
 * Tests for StreamingToolExecutor and the mid-stream helper functions.
 *
 * These tests run with Node's built-in test runner via:
 *   node --import tsx --test tests/unit/streaming-tool-executor.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamingToolExecutor,
  streamOpenAIWithEarlyExecution,
  streamAnthropicWithEarlyExecution,
  streamGeminiWithEarlyExecution
} from '../../src/executor/streaming-tool-executor.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReadableStream from SSE lines */
function makeSseStream(lines) {
  const text = lines.map(l => (l === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(l)}\n\n`)).join('');
  return new Response(new TextEncoder().encode(text)).body;
}

/** Build a Response whose body is raw UTF-8 bytes (no SSE wrapping) */
function makeRawStream(text) {
  return new Response(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// StreamingToolExecutor unit tests
// ---------------------------------------------------------------------------

describe('StreamingToolExecutor', () => {
  test('executes a tool immediately on onToolUseComplete', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name, args) => {
      calls.push({ name, args });
      return { output: `result-${name}` };
    });

    executor.onToolUseComplete('id-1', 'read_file', { file_path: '/tmp/foo.ts' });
    assert.equal(executor.pendingCount, 1);

    const results = await executor.getRemainingResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, 'read_file');
    assert.equal(results[0].result.output, 'result-read_file');
    assert.equal(calls.length, 1);
  });

  test('does not fire the same toolId twice', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name) => {
      calls.push(name);
      return 'ok';
    });

    executor.onToolUseComplete('same-id', 'grep_search', { pattern: 'foo' });
    executor.onToolUseComplete('same-id', 'grep_search', { pattern: 'foo' }); // duplicate

    const results = await executor.getRemainingResults();
    assert.equal(calls.length, 1, 'should only execute once');
    assert.equal(results.length, 1);
  });

  test('captures error from a failing tool', async () => {
    const executor = new StreamingToolExecutor(async () => {
      throw new Error('Tool exploded');
    });

    executor.onToolUseComplete('err-id', 'bad_tool', {});
    const results = await executor.getRemainingResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'Tool exploded');
    assert.equal(results[0].result, null);
  });

  test('runs multiple tools concurrently', async () => {
    const order = [];
    const makeDelayedTool = (name, delayMs) => async () => {
      await new Promise(r => setTimeout(r, delayMs));
      order.push(name);
      return `done-${name}`;
    };

    const fns = {
      fast: makeDelayedTool('fast', 5),
      slow: makeDelayedTool('slow', 200)
    };

    const executor = new StreamingToolExecutor(async (name) => fns[name]?.());

    executor.onToolUseComplete('t1', 'slow', {});
    executor.onToolUseComplete('t2', 'fast', {});

    const results = await executor.getRemainingResults();
    assert.equal(results.length, 2);
    // fast should finish before slow even though slow was started first
    assert.equal(order[0], 'fast');
    assert.equal(order[1], 'slow');
  });

  test('getRemainingResults clears state for reuse', async () => {
    const executor = new StreamingToolExecutor(async () => 'ok');

    executor.onToolUseComplete('a', 'tool_a', {});
    const first = await executor.getRemainingResults();
    assert.equal(first.length, 1);

    // After clearing, a second call returns nothing
    const second = await executor.getRemainingResults();
    assert.equal(second.length, 0);
  });

  test('hasPendingTools reflects running state', async () => {
    let resolveHold;
    const holdPromise = new Promise(r => { resolveHold = r; });

    const executor = new StreamingToolExecutor(async () => {
      await holdPromise;
      return 'done';
    });

    executor.onToolUseComplete('held', 'hold_tool', {});
    assert.ok(executor.hasPendingTools, 'should have pending tools while running');

    resolveHold();
    await executor.getRemainingResults();
    assert.ok(!executor.hasPendingTools, 'should clear after results collected');
  });

  test('durationMs is measured for successful tools', async () => {
    const executor = new StreamingToolExecutor(async () => {
      await new Promise(r => setTimeout(r, 50));
      return 'ok';
    });

    executor.onToolUseComplete('dur', 'slow_tool', {});
    const results = await executor.getRemainingResults();
    // Allow some clock slack for CI; setTimeout(50) under load can clock as low as ~30ms
    assert.ok(results[0].durationMs >= 30, `expected durationMs >= 30 but got ${results[0].durationMs}`);
  });
});

// ---------------------------------------------------------------------------
// streamOpenAIWithEarlyExecution
// ---------------------------------------------------------------------------

describe('streamOpenAIWithEarlyExecution', () => {
  test('fires tool call when arguments are complete JSON', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name, args) => {
      calls.push({ name, args });
      return 'ok';
    });

    // Simulate a stream: two chunks, the second completes the args JSON
    const delta1 = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"file_p' } }] } }] };
    const delta2 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath": "/tmp/x.ts"}' } }] }, finish_reason: 'tool_calls' }] };

    const bodyText = `data: ${JSON.stringify(delta1)}\n\ndata: ${JSON.stringify(delta2)}\n\ndata: [DONE]\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    const { text, toolCallIds } = await streamOpenAIWithEarlyExecution(response, executor);
    const results = await executor.getRemainingResults();

    assert.equal(toolCallIds.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, 'read_file');
    assert.deepEqual(results[0].result, 'ok');
    assert.equal(text, '');
  });

  test('captures text content', async () => {
    const executor = new StreamingToolExecutor(async () => 'noop');

    const delta = { choices: [{ delta: { content: 'Hello world' } }] };
    const bodyText = `data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    const { text } = await streamOpenAIWithEarlyExecution(response, executor);
    assert.equal(text, 'Hello world');
  });

  test('fires tools with complete single-chunk arguments', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name, args) => {
      calls.push({ name, args });
      return 'called';
    });

    const delta = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'tc_x',
            function: { name: 'grep_search', arguments: '{"pattern":"TODO"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    };

    const bodyText = `data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    await streamOpenAIWithEarlyExecution(response, executor);
    const results = await executor.getRemainingResults();

    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, 'grep_search');
    assert.deepEqual(calls[0].args, { pattern: 'TODO' });
  });
});

// ---------------------------------------------------------------------------
// streamAnthropicWithEarlyExecution
// ---------------------------------------------------------------------------

describe('streamAnthropicWithEarlyExecution', () => {
  test('fires tool on content_block_stop', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name, args) => {
      calls.push({ name, args });
      return 'anthropic-result';
    });

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'write_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/out.txt","' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'content":"hello"}' } },
      { type: 'content_block_stop', index: 0 }
    ];

    const bodyText = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const response = new Response(new TextEncoder().encode(bodyText));

    const { toolCallIds } = await streamAnthropicWithEarlyExecution(response, executor);
    const results = await executor.getRemainingResults();

    assert.equal(toolCallIds.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, 'write_file');
    assert.deepEqual(calls[0].args, { file_path: '/tmp/out.txt', content: 'hello' });
  });

  test('captures text deltas', async () => {
    const executor = new StreamingToolExecutor(async () => 'noop');

    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part 1 ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part 2' } }
    ];

    const bodyText = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const response = new Response(new TextEncoder().encode(bodyText));

    const textChunks = [];
    const { text } = await streamAnthropicWithEarlyExecution(response, executor, chunk => textChunks.push(chunk));

    assert.equal(text, 'Part 1 Part 2');
    assert.deepEqual(textChunks, ['Part 1 ', 'Part 2']);
  });

  test('fires multiple tool blocks from same stream', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name, args) => {
      calls.push(name);
      return 'ok';
    });

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_a', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_b', name: 'glob' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pattern":"**/*.ts"}' } },
      { type: 'content_block_stop', index: 1 }
    ];

    const bodyText = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const response = new Response(new TextEncoder().encode(bodyText));

    const { toolCallIds } = await streamAnthropicWithEarlyExecution(response, executor);
    const results = await executor.getRemainingResults();

    assert.equal(toolCallIds.length, 2);
    assert.equal(results.length, 2);
    assert.ok(calls.includes('read_file'));
    assert.ok(calls.includes('glob'));
  });
});

// ---------------------------------------------------------------------------
// streamGeminiWithEarlyExecution
// ---------------------------------------------------------------------------

describe('streamGeminiWithEarlyExecution', () => {
  test('fires tool immediately on functionCall chunk', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name, args) => {
      calls.push({ name, args });
      return 'gemini-ok';
    });

    const chunk = {
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'run_shell_command', args: { command: 'ls' } } }]
        }
      }]
    };

    const bodyText = `data: ${JSON.stringify(chunk)}\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    const { toolCallIds } = await streamGeminiWithEarlyExecution(response, executor);
    const results = await executor.getRemainingResults();

    assert.equal(toolCallIds.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].toolName, 'run_shell_command');
    assert.deepEqual(calls[0].args, { command: 'ls' });
  });

  test('captures text parts from Gemini stream', async () => {
    const executor = new StreamingToolExecutor(async () => 'noop');

    const chunk = {
      candidates: [{
        content: { parts: [{ text: 'Thinking about the problem...' }] }
      }]
    };

    const bodyText = `data: ${JSON.stringify(chunk)}\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    const textParts = [];
    const { text } = await streamGeminiWithEarlyExecution(response, executor, c => textParts.push(c));

    assert.equal(text, 'Thinking about the problem...');
    assert.equal(textParts.length, 1);
  });

  test('handles multiple functionCall parts in one chunk', async () => {
    const calls = [];
    const executor = new StreamingToolExecutor(async (name) => {
      calls.push(name);
      return 'ok';
    });

    const chunk = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { name: 'read_file', args: { file_path: '/a' } } },
            { functionCall: { name: 'grep_search', args: { pattern: 'TODO' } } }
          ]
        }
      }]
    };

    const bodyText = `data: ${JSON.stringify(chunk)}\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    const { toolCallIds } = await streamGeminiWithEarlyExecution(response, executor);
    const results = await executor.getRemainingResults();

    assert.equal(toolCallIds.length, 2);
    assert.equal(results.length, 2);
    assert.ok(calls.includes('read_file'));
    assert.ok(calls.includes('grep_search'));
  });

  test('assigns unique toolIds to each Gemini function call', async () => {
    const executor = new StreamingToolExecutor(async () => 'ok');

    const chunk = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { name: 'tool_a', args: {} } },
            { functionCall: { name: 'tool_b', args: {} } }
          ]
        }
      }]
    };

    const bodyText = `data: ${JSON.stringify(chunk)}\n\n`;
    const response = new Response(new TextEncoder().encode(bodyText));

    const { toolCallIds } = await streamGeminiWithEarlyExecution(response, executor);

    assert.equal(toolCallIds.length, 2);
    assert.notEqual(toolCallIds[0], toolCallIds[1], 'Each tool call must have a unique id');
  });
});
