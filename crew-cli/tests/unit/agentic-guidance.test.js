import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskModeGuidance,
  buildTurnGuidance,
  detectTaskMode
} from '../../src/execution/agentic-guidance.ts';

describe('agentic-guidance', () => {
  it('classifies test repair tasks before generic bugfixes', () => {
    assert.equal(detectTaskMode('fix the failing unit test for auth'), 'test_repair');
  });

  it('returns mode-specific task guidance', () => {
    assert.match(buildTaskModeGuidance('refactor'), /Preserve behavior/);
  });

  it('adds guidance for unread edits and missing verification', () => {
    const history = [
      {
        turn: 1,
        tool: 'replace',
        params: { file_path: 'src/app.ts' },
        result: 'patched'
      }
    ];
    const guidance = buildTurnGuidance('feature', history, history);
    assert.ok(guidance);
    assert.match(guidance, /Read before editing/);
    assert.match(guidance, /verification command/);
  });

  it('flags repeated failing actions', () => {
    const history = [
      {
        turn: 1,
        tool: 'run_shell_command',
        params: { command: 'npm test auth' },
        result: null,
        error: 'failed'
      },
      {
        turn: 2,
        tool: 'run_shell_command',
        params: { command: 'npm test auth' },
        result: null,
        error: 'failed'
      }
    ];
    const guidance = buildTurnGuidance('bugfix', history, [history[1]]);
    assert.ok(guidance);
    assert.match(guidance, /Do not repeat the same failing action again/);
  });
});
