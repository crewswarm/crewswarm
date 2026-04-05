import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let PatchCritic, StructuredHistory;

describe('PatchCritic', async () => {
  before(async () => {
    const pc = await import('../../src/engine/patch-critic.ts');
    const sh = await import('../../src/engine/structured-history.ts');
    PatchCritic = pc.PatchCritic;
    StructuredHistory = sh.StructuredHistory;
  });

  it('flags unread edits', () => {
    const critic = new PatchCritic();
    const history = new StructuredHistory();
    // Write without reading first
    history.recordToolExecution({ turn: 1, tool: 'write_file', params: { file_path: 'a.ts' }, result: 'ok', durationMs: 10, filesAffected: ['a.ts'], readOnly: false });
    const report = critic.evaluate(1, 'write_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(report.findings.some(f => f.category === 'unread-edit'));
  });

  it('rewards read-before-write', () => {
    const critic = new PatchCritic();
    const history = new StructuredHistory();
    history.recordToolExecution({ turn: 1, tool: 'read_file', params: { file_path: 'a.ts' }, result: 'contents', durationMs: 5, filesAffected: ['a.ts'], readOnly: true });
    history.recordToolExecution({ turn: 2, tool: 'edit_file', params: { file_path: 'a.ts' }, result: 'ok', durationMs: 10, filesAffected: ['a.ts'], readOnly: false });
    const report = critic.evaluate(2, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(report.findings.some(f => f.category === 'good-practice'));
  });

  it('detects excessive churn', () => {
    const critic = new PatchCritic({ churnThreshold: 2 });
    const history = new StructuredHistory();
    history.recordToolExecution({ turn: 1, tool: 'read_file', params: { file_path: 'a.ts' }, result: 'x', durationMs: 5, filesAffected: ['a.ts'], readOnly: true });

    critic.evaluate(1, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    const report = critic.evaluate(2, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(report.findings.some(f => f.category === 'excessive-churn'));
  });

  it('detects overwrite risk', () => {
    const critic = new PatchCritic();
    const history = new StructuredHistory();
    history.recordToolExecution({ turn: 1, tool: 'read_file', params: { file_path: 'a.ts' }, result: 'x', durationMs: 5, filesAffected: ['a.ts'], readOnly: true });
    history.recordToolExecution({ turn: 1, tool: 'edit_file', params: { file_path: 'a.ts' }, result: 'ok', durationMs: 10, filesAffected: ['a.ts'], readOnly: false });
    // Now write_file on same file — overwrite risk
    const report = critic.evaluate(2, 'write_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(report.findings.some(f => f.category === 'overwrite-risk'));
  });

  it('detects scope creep', () => {
    const critic = new PatchCritic({ allowedPaths: ['src/'] });
    const history = new StructuredHistory();
    const report = critic.evaluate(1, 'write_file', { file_path: 'lib/other.ts' }, 'ok', undefined, history);
    assert.ok(report.findings.some(f => f.category === 'scope-creep'));
  });

  it('allows in-scope writes', () => {
    const critic = new PatchCritic({ allowedPaths: ['src/'] });
    const history = new StructuredHistory();
    const report = critic.evaluate(1, 'write_file', { file_path: 'src/index.ts' }, 'ok', undefined, history);
    assert.ok(!report.findings.some(f => f.category === 'scope-creep'));
  });

  it('rewards verification after edits', () => {
    const critic = new PatchCritic();
    const history = new StructuredHistory();
    history.recordToolExecution({ turn: 1, tool: 'read_file', params: { file_path: 'a.ts' }, result: 'x', durationMs: 5, filesAffected: ['a.ts'], readOnly: true });
    critic.evaluate(1, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    const report = critic.evaluate(2, 'run_shell_command', { command: 'npm test' }, 'ok', undefined, history);
    assert.ok(report.findings.some(f => f.category === 'good-practice' && f.message.includes('verification')));
  });

  it('produces guidance string for warnings', () => {
    const critic = new PatchCritic();
    const history = new StructuredHistory();
    const report = critic.evaluate(1, 'write_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(report.guidance.includes('Patch quality'));
  });

  it('computes score', () => {
    const critic = new PatchCritic();
    const history = new StructuredHistory();
    history.recordToolExecution({ turn: 1, tool: 'read_file', params: { file_path: 'a.ts' }, result: 'x', durationMs: 5, filesAffected: ['a.ts'], readOnly: true });
    history.recordToolExecution({ turn: 2, tool: 'edit_file', params: { file_path: 'a.ts' }, result: 'ok', durationMs: 10, filesAffected: ['a.ts'], readOnly: false });
    const report = critic.evaluate(2, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(report.score >= 0 && report.score <= 100);
  });

  it('resets state', () => {
    const critic = new PatchCritic({ churnThreshold: 2 });
    const history = new StructuredHistory();
    critic.evaluate(1, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    critic.evaluate(2, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    critic.reset();
    const report = critic.evaluate(3, 'edit_file', { file_path: 'a.ts' }, 'ok', undefined, history);
    assert.ok(!report.findings.some(f => f.category === 'excessive-churn'));
  });
});
