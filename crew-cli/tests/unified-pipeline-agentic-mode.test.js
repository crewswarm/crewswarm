import test from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedPipeline } from '../src/pipeline/unified.ts';

test('canUseNativeGeminiToolLoop accepts provider-prefixed Gemini model ids', () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalMode = process.env.CREW_TOOL_MODE;

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.CREW_TOOL_MODE = 'auto';

  const pipeline = new UnifiedPipeline({ baseDir: process.cwd() });
  const canUse = pipeline['canUseNativeGeminiToolLoop']('google/gemini-2.5-flash');
  assert.equal(canUse, true);

  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
  if (originalMode === undefined) delete process.env.CREW_TOOL_MODE;
  else process.env.CREW_TOOL_MODE = originalMode;
});

test('canUseNativeGeminiToolLoop disables native loop in markers mode', () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalMode = process.env.CREW_TOOL_MODE;

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.CREW_TOOL_MODE = 'markers';

  const pipeline = new UnifiedPipeline({ baseDir: process.cwd() });
  const canUse = pipeline['canUseNativeGeminiToolLoop']('google/gemini-2.5-flash');
  assert.equal(canUse, false);

  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
  if (originalMode === undefined) delete process.env.CREW_TOOL_MODE;
  else process.env.CREW_TOOL_MODE = originalMode;
});

test('parseToolCalls ignores incomplete write blocks and sanitizes marker paths', () => {
  const pipeline = new UnifiedPipeline({ baseDir: process.cwd() });
  const calls = pipeline['parseToolCalls']([
    '@@WRITE_FILE src/ok.ts',
    'export const ok = true;',
    '@@END_FILE',
    '',
    '@@WRITE_FILE src/bad.ts',
    'missing terminator should be ignored',
    '',
    '@@EDIT "foo" → "bar" file4.js`;',
    '@@MKDIR docs`;',
    '@@EDIT "x" → "y" bad@@path.js'
  ].join('\n'));

  assert.deepEqual(
    calls.map((call) => ({ toolName: call.toolName, path: call.params.file_path || call.params.path })),
    [
      { toolName: 'write_file', path: 'src/ok.ts' },
      { toolName: 'edit', path: 'file4.js' },
      { toolName: 'mkdir', path: 'docs' }
    ]
  );
});

test('qaAuditResponse requests strict JSON mode', async () => {
  const pipeline = new UnifiedPipeline({ baseDir: process.cwd() });
  let executeOptions = null;
  pipeline.composer = {
    compose: () => ({ finalPrompt: 'mock-qa-prompt' })
  };
  pipeline.executor = {
    execute: async (_prompt, options) => {
      executeOptions = options;
      return { success: true, result: '{"approved":true,"summary":"ok","issues":[]}', costUsd: 0.001 };
    }
  };

  const result = await pipeline['qaAuditResponse']('@@WRITE_FILE src/a.ts\nx\n@@END_FILE', 'trace-json', 1, 'session-1');
  assert.equal(result.approved, true);
  assert.equal(executeOptions.jsonMode, true);
});
