import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConcurrencySafe,
  partitionToolCalls,
} from '../../src/executor/tool-batching.ts';

describe('isConcurrencySafe', () => {
  it('returns true for known read-only tools', () => {
    const readOnly = [
      'file_read', 'read_file', 'grep', 'grep_search', 'glob', 'find_files',
      'web_search', 'google_web_search', 'web_fetch', 'list_directory',
      'read_many_files', 'search_code', 'find_functions', 'find_classes',
      'ls', 'git_log', 'git_diff', 'git_status', 'git_show', 'git_blame',
      'get_internal_docs',
    ];
    for (const tool of readOnly) {
      assert.equal(isConcurrencySafe(tool), true, `expected ${tool} to be concurrency-safe`);
    }
  });

  it('returns false for write tools', () => {
    const write = ['file_write', 'write_file', 'file_edit', 'bash', 'run_cmd', 'mkdir', 'run_shell_command', 'git'];
    for (const tool of write) {
      assert.equal(isConcurrencySafe(tool), false, `expected ${tool} to be unsafe`);
    }
  });

  it('returns false for unknown tools', () => {
    assert.equal(isConcurrencySafe('totally_unknown_tool'), false);
  });
});

describe('partitionToolCalls', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(partitionToolCalls([]), []);
  });

  it('wraps a single read-only tool in a concurrent batch', () => {
    const batches = partitionToolCalls([{ tool: 'grep', params: {} }]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].concurrent, true);
    assert.equal(batches[0].calls.length, 1);
  });

  it('wraps a single write tool in a serial batch', () => {
    const batches = partitionToolCalls([{ tool: 'file_write', params: {} }]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].concurrent, false);
    assert.equal(batches[0].calls.length, 1);
  });

  it('groups consecutive read-only calls into one concurrent batch', () => {
    const calls = [
      { tool: 'grep', params: {} },
      { tool: 'glob', params: {} },
      { tool: 'read_file', params: {} },
    ];
    const batches = partitionToolCalls(calls);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].concurrent, true);
    assert.equal(batches[0].calls.length, 3);
  });

  it('splits mixed sequence into alternating concurrent/serial batches', () => {
    const calls = [
      { tool: 'grep', params: {} },
      { tool: 'grep', params: {} },
      { tool: 'file_write', params: {} },
      { tool: 'read_file', params: {} },
    ];
    const batches = partitionToolCalls(calls);
    assert.equal(batches.length, 3);

    assert.equal(batches[0].concurrent, true);
    assert.equal(batches[0].calls.length, 2);

    assert.equal(batches[1].concurrent, false);
    assert.equal(batches[1].calls.length, 1);
    assert.equal(batches[1].calls[0].tool, 'file_write');

    assert.equal(batches[2].concurrent, true);
    assert.equal(batches[2].calls.length, 1);
    assert.equal(batches[2].calls[0].tool, 'read_file');
  });

  it('each write tool gets its own serial batch', () => {
    const calls = [
      { tool: 'file_write', params: {} },
      { tool: 'run_shell_command', params: {} },
    ];
    const batches = partitionToolCalls(calls);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].concurrent, false);
    assert.equal(batches[1].concurrent, false);
  });

  it('handles all-write sequence without concurrent batches', () => {
    const calls = [
      { tool: 'bash', params: {} },
      { tool: 'mkdir', params: {} },
      { tool: 'file_write', params: {} },
    ];
    const batches = partitionToolCalls(calls);
    assert.equal(batches.length, 3);
    assert.ok(batches.every(b => !b.concurrent));
  });

  it('preserves call order within each batch', () => {
    const calls = [
      { tool: 'grep', params: { q: 1 } },
      { tool: 'glob', params: { q: 2 } },
    ];
    const batches = partitionToolCalls(calls);
    assert.equal(batches[0].calls[0].params.q, 1);
    assert.equal(batches[0].calls[1].params.q, 2);
  });

  it('restarts a concurrent batch after a write tool', () => {
    const calls = [
      { tool: 'grep', params: { n: 1 } },
      { tool: 'file_write', params: {} },
      { tool: 'grep', params: { n: 2 } },
      { tool: 'glob', params: { n: 3 } },
    ];
    const batches = partitionToolCalls(calls);
    assert.equal(batches.length, 3);
    assert.equal(batches[2].concurrent, true);
    assert.equal(batches[2].calls.length, 2);
  });
});
