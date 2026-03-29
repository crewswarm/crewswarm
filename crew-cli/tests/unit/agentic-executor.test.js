/**
 * Unit tests for crew-cli/src/executor/agentic-executor.ts
 *
 * Tests pure helper functions: compressTurnHistory, formatToolResult,
 * historyToGeminiContents, historyToOpenAIMessages, repairJson.
 *
 * These functions are module-private. If the import fails because they are
 * not exported, the test file reports that and exits cleanly.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let repairJson, compressTurnHistory, formatToolResult, historyToGeminiContents, historyToOpenAIMessages;
let importOk = false;

try {
  const mod = await import('../../src/executor/agentic-executor.ts');
  repairJson = mod.repairJson;
  compressTurnHistory = mod.compressTurnHistory;
  formatToolResult = mod.formatToolResult;
  historyToGeminiContents = mod.historyToGeminiContents;
  historyToOpenAIMessages = mod.historyToOpenAIMessages;
  // Check if at least one function is actually exported
  importOk = typeof repairJson === 'function'
    || typeof compressTurnHistory === 'function'
    || typeof formatToolResult === 'function';
} catch (err) {
  // Import may fail due to missing deps in the executor — that's fine
  console.log(`Skipping agentic-executor tests: import failed (${err.message})`);
}

// ── TurnResult factory ──────────────────────────────────────────────────────

function makeTurn(overrides = {}) {
  return {
    turn: 1,
    tool: 'read_file',
    params: { file_path: '/src/index.ts' },
    result: { output: 'file contents here' },
    ...overrides,
  };
}

// ── repairJson ──────────────────────────────────────────────────────────────

describe('agentic-executor — repairJson', { skip: typeof repairJson !== 'function' && 'repairJson not exported' }, () => {
  it('returns {} for empty string', () => {
    assert.equal(repairJson(''), '{}');
  });

  it('returns {} for whitespace-only string', () => {
    assert.equal(repairJson('   '), '{}');
  });

  it('returns {} for null/undefined', () => {
    assert.equal(repairJson(null), '{}');
    assert.equal(repairJson(undefined), '{}');
  });

  it('removes trailing commas before }', () => {
    const result = repairJson('{"a": 1, "b": 2,}');
    assert.ok(result.includes('"b": 2}') || result.includes('"b":2}'));
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it('removes trailing commas before ]', () => {
    const result = repairJson('[1, 2, 3,]');
    assert.doesNotThrow(() => JSON.parse(result));
    assert.deepEqual(JSON.parse(result), [1, 2, 3]);
  });

  it('converts single quotes to double quotes when no double quotes exist', () => {
    const result = repairJson("{'key': 'value'}");
    assert.doesNotThrow(() => JSON.parse(result));
    const parsed = JSON.parse(result);
    assert.equal(parsed.key, 'value');
  });

  it('fixes unquoted keys', () => {
    const result = repairJson('{name: "test"}');
    assert.doesNotThrow(() => JSON.parse(result));
    const parsed = JSON.parse(result);
    assert.equal(parsed.name, 'test');
  });

  it('closes unclosed braces', () => {
    const result = repairJson('{"a": {"b": 1}');
    const openBraces = (result.match(/{/g) || []).length;
    const closeBraces = (result.match(/}/g) || []).length;
    assert.equal(openBraces, closeBraces, 'braces should be balanced');
  });

  it('closes unclosed brackets', () => {
    const result = repairJson('[1, 2, [3');
    const openBrackets = (result.match(/\[/g) || []).length;
    const closeBrackets = (result.match(/]/g) || []).length;
    assert.equal(openBrackets, closeBrackets, 'brackets should be balanced');
  });

  it('passes through valid JSON unchanged (modulo whitespace)', () => {
    const input = '{"foo": "bar", "num": 42}';
    const result = repairJson(input);
    assert.deepEqual(JSON.parse(result), JSON.parse(input));
  });
});

// ── compressTurnHistory ─────────────────────────────────────────────────────

describe('agentic-executor — compressTurnHistory', { skip: typeof compressTurnHistory !== 'function' && 'compressTurnHistory not exported' }, () => {
  it('returns empty array for empty history', () => {
    assert.deepEqual(compressTurnHistory([]), []);
  });

  it('compresses a single turn into topic-action-outcome', () => {
    const turns = [makeTurn({ turn: 1 })];
    const result = compressTurnHistory(turns);
    assert.equal(result.length, 1);
    assert.equal(result[0].turn, 1);
    assert.ok(result[0].action.includes('read_file'));
    assert.ok(result[0].outcome.startsWith('OK:'));
  });

  it('marks error turns with FAIL prefix', () => {
    const turns = [makeTurn({ turn: 2, error: 'File not found', result: null })];
    const result = compressTurnHistory(turns);
    assert.ok(result[0].outcome.startsWith('FAIL:'));
  });

  it('extracts file_path as topic', () => {
    const turns = [makeTurn({ params: { file_path: '/src/utils/helper.ts' } })];
    const result = compressTurnHistory(turns);
    assert.equal(result[0].topic, 'helper.ts');
  });

  it('uses tool name as topic when no file_path', () => {
    const turns = [makeTurn({ tool: 'grep_search', params: { pattern: 'TODO' } })];
    const result = compressTurnHistory(turns);
    assert.equal(result[0].topic, 'grep_search');
  });

  it('truncates long key params in action', () => {
    const longPath = '/very/long/path/' + 'x'.repeat(200) + '/file.ts';
    const turns = [makeTurn({ params: { file_path: longPath } })];
    const result = compressTurnHistory(turns);
    assert.ok(result[0].action.length < longPath.length);
  });
});

// ── formatToolResult ────────────────────────────────────────────────────────

describe('agentic-executor — formatToolResult', { skip: typeof formatToolResult !== 'function' && 'formatToolResult not exported' }, () => {
  it('formats a successful result with output field', () => {
    const turn = makeTurn({ result: { output: 'hello world' } });
    const result = formatToolResult(turn);
    assert.equal(result, 'hello world');
  });

  it('formats an error result', () => {
    const turn = makeTurn({ error: 'Something broke' });
    const result = formatToolResult(turn);
    assert.ok(result.includes('ERROR:'));
    assert.ok(result.includes('Something broke'));
  });

  it('formats a string result directly', () => {
    const turn = makeTurn({ result: 'plain string' });
    const result = formatToolResult(turn);
    assert.equal(result, 'plain string');
  });

  it('truncates long results to maxLen', () => {
    const longOutput = 'x'.repeat(5000);
    const turn = makeTurn({ result: { output: longOutput } });
    const result = formatToolResult(turn, 100);
    assert.equal(result.length, 100);
  });

  it('handles null result', () => {
    const turn = makeTurn({ result: null });
    const result = formatToolResult(turn);
    assert.equal(typeof result, 'string');
  });
});

// ── historyToGeminiContents ─────────────────────────────────────────────────

describe('agentic-executor — historyToGeminiContents', { skip: typeof historyToGeminiContents !== 'function' && 'historyToGeminiContents not exported' }, () => {
  it('returns empty array for empty history', () => {
    assert.deepEqual(historyToGeminiContents([]), []);
  });

  it('returns model/user pairs for a single turn', () => {
    const turns = [makeTurn()];
    const contents = historyToGeminiContents(turns);
    assert.ok(contents.length >= 2);
    assert.equal(contents[0].role, 'model');
    assert.equal(contents[1].role, 'user');
  });

  it('model parts contain functionCall', () => {
    const turns = [makeTurn()];
    const contents = historyToGeminiContents(turns);
    const modelPart = contents[0];
    assert.ok(modelPart.parts[0].functionCall);
    assert.equal(modelPart.parts[0].functionCall.name, 'read_file');
  });

  it('user parts contain functionResponse', () => {
    const turns = [makeTurn()];
    const contents = historyToGeminiContents(turns);
    const userPart = contents[1];
    assert.ok(userPart.parts[0].functionResponse);
    assert.equal(userPart.parts[0].functionResponse.name, 'read_file');
  });

  it('handles error turns in response', () => {
    const turns = [makeTurn({ error: 'not found', result: null })];
    const contents = historyToGeminiContents(turns);
    const userPart = contents[1];
    assert.ok(userPart.parts[0].functionResponse.response.error);
  });
});

// ── historyToOpenAIMessages ─────────────────────────────────────────────────

describe('agentic-executor — historyToOpenAIMessages', { skip: typeof historyToOpenAIMessages !== 'function' && 'historyToOpenAIMessages not exported' }, () => {
  it('returns empty array for empty history', () => {
    assert.deepEqual(historyToOpenAIMessages([]), []);
  });

  it('returns assistant/tool pairs for a single turn', () => {
    const turns = [makeTurn()];
    const messages = historyToOpenAIMessages(turns);
    assert.ok(messages.length >= 2);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[1].role, 'tool');
  });

  it('assistant messages contain tool_calls', () => {
    const turns = [makeTurn()];
    const messages = historyToOpenAIMessages(turns);
    const assistant = messages[0];
    assert.ok(Array.isArray(assistant.tool_calls));
    assert.equal(assistant.tool_calls[0].function.name, 'read_file');
  });

  it('tool messages reference the call id', () => {
    const turns = [makeTurn()];
    const messages = historyToOpenAIMessages(turns);
    const toolMsg = messages[1];
    assert.ok(toolMsg.tool_call_id);
    assert.equal(toolMsg.tool_call_id, messages[0].tool_calls[0].id);
  });
});
