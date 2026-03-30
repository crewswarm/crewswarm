import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls, buildReplayPlan, previewAuditOutput } from '../../src/engines/tool-audit.ts';

describe('tool-audit', () => {
  it('extractToolCalls finds @@WRITE_FILE', () => {
    const calls = extractToolCalls('@@WRITE_FILE src/foo.ts\ncontent\n@@END_FILE');
    assert.ok(calls.length >= 1);
    assert.equal(calls[0].name, 'write_file');
    assert.equal(calls[0].args.file_path, 'src/foo.ts');
  });

  it('extractToolCalls finds @@MKDIR', () => {
    const calls = extractToolCalls('@@MKDIR src/new');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'mkdir');
  });

  it('extractToolCalls returns empty for no tool calls', () => {
    const calls = extractToolCalls('just plain text');
    assert.deepEqual(calls, []);
  });

  it('buildReplayPlan filters to supported mutations', () => {
    const run = {
      runId: 'r1', ts: '', engine: 'test', prompt: '', success: true, exitCode: 0,
      rawOutputPreview: '',
      toolCalls: [
        { name: 'write_file', args: { file_path: 'x.ts' } },
        { name: 'read_file', args: { file_path: 'y.ts' } },
        { name: 'mkdir', args: { path: 'z' } }
      ]
    };
    const plan = buildReplayPlan(run);
    assert.equal(plan.deterministicOrder.length, 3);
    assert.equal(plan.supportedMutations.length, 2);
  });

  it('previewAuditOutput clips long text', () => {
    const long = 'x'.repeat(10000);
    const preview = previewAuditOutput(long);
    assert.ok(preview.length < long.length);
    assert.ok(preview.includes('[truncated]'));
  });
});
