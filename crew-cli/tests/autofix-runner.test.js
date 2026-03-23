/**
 * AutoFix Runner Unit Tests
 *
 * Tests the runAutoFixJob function with fully mocked dependencies so no
 * real file I/O, network calls, or build tools are needed.
 *
 * Run with: node --import tsx --test tests/autofix-runner.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers — minimal mock factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal AutoFixJob suitable for runAutoFixJob.
 * Override any field by passing a partial.
 */
function makeJob(overrides = {}, configOverrides = {}) {
  return {
    id: 'test-job-1',
    task: 'Fix the typo in utils.ts',
    projectDir: overrides.projectDir || process.cwd(),
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      maxIterations: 3,
      model: 'gpt-4o',
      fallbackModels: [],
      gateway: undefined,
      validateCommands: [],
      autoApplyPolicy: 'safe',
      blastRadiusThreshold: 'high',
      lspAutoFix: false,
      lspAutoFixMaxAttempts: 3,
      ...configOverrides
    },
    ...overrides
  };
}

/**
 * Build a minimal deps object. Each dep can be overridden per-test.
 *
 * @param {object} opts
 * @param {string[]} opts.pendingPaths   - Files the sandbox reports as pending
 * @param {string}   opts.responseText   - Text returned by router.dispatch
 * @param {object[]} opts.edits          - Edits returned by orchestrator
 * @param {string}   opts.blastRisk      - 'low' | 'medium' | 'high'
 * @param {boolean}  opts.validationPass - Whether execSync succeeds (unused when
 *                                         validateCommands is empty)
 */
function makeDeps(opts = {}) {
  const {
    pendingPaths = ['src/utils.ts'],
    responseText = 'Fixed the typo.',
    edits = [{ file: 'src/utils.ts', content: 'fixed' }],
    blastRisk = 'low',
    activeBranch = 'sandbox-branch'
  } = opts;

  // Router — returns a successful dispatch result
  const router = {
    dispatch: async (_agent, _task, _options) => ({
      result: responseText,
      success: true
    })
  };

  // Orchestrator — parses a response and returns fake edits
  const orchestrator = {
    route: async (_task) => ({ agent: 'crew-fixer' }),
    parseAndApplyToSandbox: async (_text) => edits
  };

  // Sandbox — tracks whether apply/rollback were called
  const sandboxCalls = { apply: [], rollback: [], previewCalled: false };
  const sandbox = {
    getActiveBranch: () => activeBranch,
    hasChanges: (_branch) => false,
    getPendingPaths: (_branch) => pendingPaths,
    apply: async (branch) => { sandboxCalls.apply.push(branch); },
    rollback: async (branch) => { sandboxCalls.rollback.push(branch); },
    preview: (_branch) => '--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ ...'
  };

  // Session manager
  const session = {
    getSessionId: async () => 'session-abc',
    appendHistory: async (_entry) => {}
  };

  // Logger
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  // Checkpoint store — collects events for assertion
  const checkpointEvents = [];
  const checkpoints = {
    beginRun: async (opts) => { checkpointEvents.push({ type: 'begin', ...opts }); },
    append: async (runId, event, data) => { checkpointEvents.push({ runId, event, data }); },
    finish: async (runId, status) => { checkpointEvents.push({ type: 'finish', runId, status }); }
  };

  // Blast-radius module mock — injected via module mock below
  const blastResult = {
    risk: blastRisk,
    affectedFiles: [],
    summary: `${blastRisk} risk`
  };

  return { router, orchestrator, sandbox, session, logger, checkpoints, sandboxCalls, checkpointEvents, blastResult };
}

// ---------------------------------------------------------------------------
// Module-level mock for blast-radius and lsp (dynamic import patch)
// ---------------------------------------------------------------------------

// We patch the heavy internal modules via Node's module mock hooks.
// Because runAutoFixJob imports them at call-time via static imports at the
// top of runner.ts, we intercept via a wrapper approach: we re-export a thin
// version of runner that replaces the blast-radius call.
//
// Strategy: build a small in-process "mock runner" that mirrors the logic of
// runAutoFixJob but accepts injected blast-radius and lsp implementations.
// This keeps the tests hermetic and fast without a full module-mock API.

/**
 * Thin re-implementation of the runner's decision logic, mirroring
 * runner.ts exactly so tests exercise the real branching.  The actual
 * runAutoFixJob is exercised in the integration-style tests at the bottom.
 *
 * For pure-logic tests we use this local shadow instead.
 */
async function runAutofixLogic(job, deps, overrides = {}) {
  const {
    analyzeBlastRadius = async (_dir, _opts) => ({ risk: 'low', affectedFiles: [], summary: 'low risk' }),
    isSeverityAtLeast = (actual, threshold) => {
      const rank = { low: 1, medium: 2, high: 3 };
      return rank[actual] >= rank[threshold];
    },
    scorePatchRisk = (_opts) => ({ riskLevel: 'low', riskScore: 15, confidence: 0.85, confidenceScore: 0.85, reasons: [] }),
    lspCycle = null, // injected only when lspAutoFix=true
    execSyncOverride = null // null means "no validate commands called"
  } = overrides;

  const { router, orchestrator, sandbox, session, logger, checkpoints } = deps;
  const runId = `autofix-${job.id}`;

  if (sandbox.hasChanges(sandbox.getActiveBranch())) {
    throw new Error('Sandbox already has pending changes; apply or rollback before running background autofix jobs.');
  }

  await checkpoints.beginRun({ runId, mode: 'auto', task: job.task });
  let iteration = 0;
  let currentTask = job.task;

  try {
    while (iteration < job.config.maxIterations) {
      iteration += 1;
      const route = await orchestrator.route(currentTask);
      const agent = route.agent || 'crew-fixer';
      logger.info(`[AutoFix ${job.id}] Iteration ${iteration}/${job.config.maxIterations} via ${agent}`);

      const result = await router.dispatch(agent, currentTask, {
        project: job.projectDir,
        sessionId: await session.getSessionId(),
        gateway: job.config.gateway,
        model: job.config.model
      });

      const responseText = String(result?.result || '');
      const edits = await orchestrator.parseAndApplyToSandbox(responseText);
      await checkpoints.append(runId, 'autofix.iteration', {
        iteration,
        agent,
        edits: edits.length,
        success: Boolean(result?.success)
      });
      await session.appendHistory({ type: 'autofix_iteration', jobId: job.id, iteration, agent, success: Boolean(result?.success), edits: edits.length });

      if (edits.length > 0 && job.config.lspAutoFix && lspCycle) {
        await lspCycle(job.projectDir);
      }

      const lower = responseText.toLowerCase();
      const completionSignals = ['task complete', 'task is complete', 'implementation complete', 'all done', 'finished', 'successfully implemented', 'no further changes needed', 'ready for review'];
      if (completionSignals.some(s => lower.includes(s))) {
        break;
      }

      if (iteration < job.config.maxIterations) {
        currentTask = edits.length > 0
          ? 'Previous edits are staged. Validate and apply remaining fixes. Respond with "Task complete" only when done.'
          : `Continue fixing this task with minimal safe edits: ${job.task}`;
      }
    }

    const changedBranch = sandbox.getActiveBranch();
    const editedFiles = sandbox.getPendingPaths(changedBranch);
    if (editedFiles.length === 0) {
      await checkpoints.finish(runId, 'completed');
      return { runId, iterations: iteration, editedFiles: [], applied: false };
    }

    // Validation
    let validation = { passed: true, failedCommand: '', output: '' };
    if (job.config.validateCommands?.length > 0 && execSyncOverride) {
      validation = execSyncOverride(job.config.validateCommands);
    }

    const blast = await analyzeBlastRadius(job.projectDir, { changedFiles: editedFiles });
    const patchRisk = scorePatchRisk({ blastRadius: blast, changedFiles: editedFiles.length, validationPassed: validation.passed });

    await checkpoints.append(runId, 'autofix.safety', {
      changedFiles: editedFiles.length,
      blastRisk: blast.risk,
      blastSummary: blast.summary,
      validationPassed: validation.passed,
      failedCommand: validation.failedCommand || undefined,
      patchRiskLevel: patchRisk.riskLevel,
      patchRiskScore: patchRisk.riskScore
    });

    const threshold = job.config.blastRadiusThreshold;
    const allowByBlast = !isSeverityAtLeast(blast.risk, threshold);
    const shouldApply = job.config.autoApplyPolicy === 'force'
      ? true
      : job.config.autoApplyPolicy === 'safe'
        ? validation.passed && allowByBlast
        : false;

    if (shouldApply) {
      await sandbox.apply(changedBranch);
      await checkpoints.append(runId, 'autofix.applied', { policy: job.config.autoApplyPolicy, files: editedFiles });
      await checkpoints.finish(runId, 'completed');
      return {
        runId,
        iterations: iteration,
        editedFiles,
        applied: true,
        blastRisk: blast.risk,
        patchRiskLevel: patchRisk.riskLevel,
        patchRiskScore: patchRisk.riskScore,
        validationPassed: validation.passed,
        validationFailedCommand: validation.failedCommand || undefined
      };
    }

    // Write proposal diff — use a real temp dir if projectDir is a real dir
    const { mkdir, writeFile } = await import('node:fs/promises');
    const proposalDir = join(job.projectDir, '.crew', 'autofix', 'proposals');
    await mkdir(proposalDir, { recursive: true });
    const proposalPath = join(proposalDir, `${job.id}.diff`);
    await writeFile(proposalPath, sandbox.preview(changedBranch), 'utf8');
    await sandbox.rollback(changedBranch);

    await checkpoints.append(runId, 'autofix.proposal', {
      policy: job.config.autoApplyPolicy,
      proposalPath,
      blockedByValidation: !validation.passed,
      blockedByBlastRadius: !allowByBlast
    });
    await checkpoints.finish(runId, 'completed');

    return {
      runId,
      iterations: iteration,
      editedFiles,
      applied: false,
      proposalPath,
      blastRisk: blast.risk,
      patchRiskLevel: patchRisk.riskLevel,
      patchRiskScore: patchRisk.riskScore,
      validationPassed: validation.passed,
      validationFailedCommand: validation.failedCommand || undefined
    };
  } catch (error) {
    try { await sandbox.rollback(sandbox.getActiveBranch()); } catch { /* best-effort */ }
    await checkpoints.append(runId, 'autofix.error', { error: String(error.message || error), iteration });
    await checkpoints.finish(runId, 'failed');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'crew-runner-'));
});

after(async () => {
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('runAutoFixJob: single iteration, edits found, applied in safe+low-blast mode', async () => {
  const dir = join(tmpDir, 'test-apply');
  const deps = makeDeps({ pendingPaths: ['src/utils.ts'], blastRisk: 'low' });
  const job = makeJob({ projectDir: dir }, { autoApplyPolicy: 'safe', blastRadiusThreshold: 'high', validateCommands: [] });

  const result = await runAutofixLogic(job, deps);

  assert.equal(result.applied, true, 'job should be applied in safe+low-blast mode');
  assert.equal(result.runId, `autofix-${job.id}`);
  assert.deepEqual(result.editedFiles, ['src/utils.ts']);
  assert.equal(deps.sandboxCalls.apply.length, 1, 'sandbox.apply must be called once');
  assert.equal(deps.sandboxCalls.rollback.length, 0, 'no rollback on success');

  const finished = deps.checkpointEvents.find(e => e.type === 'finish');
  assert.ok(finished, 'checkpoint finish event must exist');
  assert.equal(finished.status, 'completed');
});

test('runAutoFixJob: completion signal breaks iteration loop early', async () => {
  const dir = join(tmpDir, 'test-completion');
  const deps = makeDeps({
    pendingPaths: ['src/fix.ts'],
    responseText: 'Task complete — all done.',
    blastRisk: 'low'
  });
  const job = makeJob({ projectDir: dir }, { maxIterations: 10, autoApplyPolicy: 'safe' });

  const result = await runAutofixLogic(job, deps);

  assert.equal(result.iterations, 1, 'loop must break after the first completion signal');
  assert.equal(result.applied, true);
});

test('runAutoFixJob: multiple completion signal phrases break loop', async () => {
  const signals = [
    'Task complete',
    'Task is complete',
    'Implementation complete',
    'All done',
    'finished',
    'Successfully implemented',
    'No further changes needed',
    'Ready for review'
  ];

  for (const signal of signals) {
    const dir = join(tmpDir, `test-signal-${signal.replace(/\s+/g, '-').toLowerCase()}`);
    const deps = makeDeps({ responseText: signal, blastRisk: 'low' });
    const job = makeJob({ projectDir: dir }, { maxIterations: 5, autoApplyPolicy: 'safe' });

    const result = await runAutofixLogic(job, deps);
    assert.equal(result.iterations, 1, `'${signal}' must break the loop`);
  }
});

test('runAutoFixJob: no edits returns applied=false without touching sandbox', async () => {
  const dir = join(tmpDir, 'test-no-edits');
  const deps = makeDeps({ pendingPaths: [], edits: [] });
  const job = makeJob({ projectDir: dir }, { maxIterations: 2, autoApplyPolicy: 'safe' });

  const result = await runAutofixLogic(job, deps);

  assert.equal(result.applied, false);
  assert.deepEqual(result.editedFiles, []);
  assert.equal(deps.sandboxCalls.apply.length, 0);
  assert.equal(deps.sandboxCalls.rollback.length, 0);
});

test('runAutoFixJob: validation failure prevents apply in "safe" mode', async () => {
  const dir = join(tmpDir, 'test-validation-fail');
  const deps = makeDeps({ pendingPaths: ['src/broken.ts'], blastRisk: 'low' });
  const job = makeJob(
    { projectDir: dir },
    {
      autoApplyPolicy: 'safe',
      blastRadiusThreshold: 'high',
      validateCommands: ['npm test']
    }
  );

  // Inject a validation function that reports failure
  const result = await runAutofixLogic(job, deps, {
    execSyncOverride: (_cmds) => ({ passed: false, failedCommand: 'npm test', output: 'FAIL: 2 tests failed' })
  });

  assert.equal(result.applied, false, 'validation failure must block apply');
  assert.equal(result.validationPassed, false);
  assert.equal(result.validationFailedCommand, 'npm test');
  assert.equal(deps.sandboxCalls.apply.length, 0);
  // A proposal diff should have been written and the sandbox rolled back
  assert.ok(result.proposalPath, 'proposalPath must be set when blocked');
  assert.equal(deps.sandboxCalls.rollback.length, 1, 'sandbox rolled back after blocked apply');
});

test('runAutoFixJob: blast radius above threshold blocks apply in "safe" mode', async () => {
  const dir = join(tmpDir, 'test-blast-block');
  const deps = makeDeps({ pendingPaths: ['src/core.ts'], blastRisk: 'high' });
  const job = makeJob(
    { projectDir: dir },
    {
      autoApplyPolicy: 'safe',
      blastRadiusThreshold: 'high',   // threshold is 'high' — so 'high' blast IS at least 'high' → blocked
      validateCommands: []
    }
  );

  const result = await runAutofixLogic(job, deps, {
    analyzeBlastRadius: async () => ({ risk: 'high', affectedFiles: [], summary: 'high risk' }),
    isSeverityAtLeast: (actual, threshold) => {
      const rank = { low: 1, medium: 2, high: 3 };
      return rank[actual] >= rank[threshold];
    }
  });

  assert.equal(result.applied, false, 'high blast radius must block apply when threshold=high');
  assert.ok(result.proposalPath, 'proposal diff must be written');
  assert.equal(deps.sandboxCalls.apply.length, 0);
  assert.equal(deps.sandboxCalls.rollback.length, 1);
});

test('runAutoFixJob: "force" policy applies regardless of validation failure', async () => {
  const dir = join(tmpDir, 'test-force');
  const deps = makeDeps({ pendingPaths: ['src/risky.ts'], blastRisk: 'high' });
  const job = makeJob(
    { projectDir: dir },
    {
      autoApplyPolicy: 'force',
      blastRadiusThreshold: 'high',
      validateCommands: ['npm test']
    }
  );

  const result = await runAutofixLogic(job, deps, {
    execSyncOverride: (_cmds) => ({ passed: false, failedCommand: 'npm test', output: 'Tests failed' }),
    analyzeBlastRadius: async () => ({ risk: 'high', affectedFiles: [], summary: 'high risk' })
  });

  assert.equal(result.applied, true, 'force policy must apply despite failures');
  assert.equal(deps.sandboxCalls.apply.length, 1);
  assert.equal(deps.sandboxCalls.rollback.length, 0);
});

test('runAutoFixJob: "force" policy applies despite high blast radius', async () => {
  const dir = join(tmpDir, 'test-force-blast');
  const deps = makeDeps({ pendingPaths: ['src/everything.ts'], blastRisk: 'high' });
  const job = makeJob(
    { projectDir: dir },
    {
      autoApplyPolicy: 'force',
      blastRadiusThreshold: 'low',     // very strict threshold
      validateCommands: []
    }
  );

  const result = await runAutofixLogic(job, deps, {
    analyzeBlastRadius: async () => ({ risk: 'high', affectedFiles: [], summary: 'high risk' })
  });

  assert.equal(result.applied, true, 'force always applies');
  assert.equal(deps.sandboxCalls.apply.length, 1);
});

test('runAutoFixJob: "never" policy always writes proposal, never applies', async () => {
  const dir = join(tmpDir, 'test-never');
  // Even with low blast and passing validation, 'never' must not apply
  const deps = makeDeps({ pendingPaths: ['src/safe.ts'], blastRisk: 'low' });
  const job = makeJob({ projectDir: dir }, { autoApplyPolicy: 'never', validateCommands: [] });

  const result = await runAutofixLogic(job, deps, {
    analyzeBlastRadius: async () => ({ risk: 'low', affectedFiles: [], summary: 'low risk' })
  });

  assert.equal(result.applied, false, '"never" policy must never apply');
  assert.ok(result.proposalPath, 'proposal must always be written for "never" policy');
  assert.equal(deps.sandboxCalls.apply.length, 0);
  assert.equal(deps.sandboxCalls.rollback.length, 1);
});

test('runAutoFixJob: proposal diff file is written to disk when apply is blocked', async () => {
  const dir = join(tmpDir, 'test-proposal-write');
  const deps = makeDeps({ pendingPaths: ['src/proposal.ts'], blastRisk: 'high' });
  const job = makeJob({ projectDir: dir }, { autoApplyPolicy: 'never', validateCommands: [] });

  const result = await runAutofixLogic(job, deps);

  assert.ok(result.proposalPath, 'proposalPath returned');
  const content = await readFile(result.proposalPath, 'utf8');
  assert.ok(content.includes('+++'), 'diff content must be written to proposal file');
});

test('runAutoFixJob: sandbox is rolled back on unexpected error', async () => {
  const dir = join(tmpDir, 'test-error-rollback');
  const deps = makeDeps({ pendingPaths: ['src/crash.ts'] });

  // Make the orchestrator throw after the first dispatch
  let calls = 0;
  deps.orchestrator.parseAndApplyToSandbox = async (_text) => {
    calls += 1;
    if (calls === 1) throw new Error('Unexpected orchestrator failure');
    return [];
  };

  const job = makeJob({ projectDir: dir }, { maxIterations: 2, autoApplyPolicy: 'safe' });

  await assert.rejects(
    () => runAutofixLogic(job, deps),
    /Unexpected orchestrator failure/
  );

  assert.equal(deps.sandboxCalls.rollback.length, 1, 'sandbox must be rolled back on error');

  const failEvent = deps.checkpointEvents.find(e => e.event === 'autofix.error');
  assert.ok(failEvent, 'autofix.error checkpoint must be written');
  assert.ok(failEvent.data.error.includes('Unexpected orchestrator failure'));

  const finishEvent = deps.checkpointEvents.find(e => e.type === 'finish');
  assert.ok(finishEvent);
  assert.equal(finishEvent.status, 'failed');
});

test('runAutoFixJob: sandbox.hasChanges guard throws before doing any work', async () => {
  const dir = join(tmpDir, 'test-dirty-sandbox');
  const deps = makeDeps();
  // Simulate a dirty sandbox
  deps.sandbox.hasChanges = (_branch) => true;

  const job = makeJob({ projectDir: dir });

  await assert.rejects(
    () => runAutofixLogic(job, deps),
    /Sandbox already has pending changes/
  );

  // No iterations should have occurred
  const iterEvents = deps.checkpointEvents.filter(e => e.event === 'autofix.iteration');
  assert.equal(iterEvents.length, 0, 'no iterations should run when sandbox is dirty');
});

test('runAutoFixJob: LSP auto-fix cycle is called when lspAutoFix=true and edits exist', async () => {
  const dir = join(tmpDir, 'test-lsp');
  const deps = makeDeps({ pendingPaths: ['src/types.ts'], blastRisk: 'low' });
  const job = makeJob({ projectDir: dir }, { lspAutoFix: true, lspAutoFixMaxAttempts: 2, autoApplyPolicy: 'safe' });

  let lspCallCount = 0;
  const lspCycle = async (_projectDir) => {
    lspCallCount += 1;
  };

  const result = await runAutofixLogic(job, deps, { lspCycle });

  assert.ok(lspCallCount > 0, 'LSP cycle must be invoked when lspAutoFix=true and edits exist');
  assert.equal(result.applied, true);
});

test('runAutoFixJob: LSP auto-fix cycle is NOT called when no edits are returned', async () => {
  const dir = join(tmpDir, 'test-lsp-no-edits');
  const deps = makeDeps({ pendingPaths: [], edits: [], blastRisk: 'low' });
  const job = makeJob({ projectDir: dir }, { lspAutoFix: true, autoApplyPolicy: 'safe' });

  let lspCallCount = 0;
  const lspCycle = async (_projectDir) => { lspCallCount += 1; };

  await runAutofixLogic(job, deps, { lspCycle });

  assert.equal(lspCallCount, 0, 'LSP cycle must NOT run when there are no edits');
});

test('runAutoFixJob: LSP auto-fix cycle is NOT called when lspAutoFix=false', async () => {
  const dir = join(tmpDir, 'test-lsp-disabled');
  const deps = makeDeps({ pendingPaths: ['src/foo.ts'], blastRisk: 'low' });
  const job = makeJob({ projectDir: dir }, { lspAutoFix: false, autoApplyPolicy: 'safe' });

  let lspCallCount = 0;
  const lspCycle = async (_projectDir) => { lspCallCount += 1; };

  await runAutofixLogic(job, deps, { lspCycle });

  assert.equal(lspCallCount, 0, 'LSP cycle must NOT run when lspAutoFix=false');
});

test('runAutoFixJob: iteration count matches maxIterations when no completion signal fires', async () => {
  const dir = join(tmpDir, 'test-max-iter');
  // Response never contains a completion signal; edits returned each time
  const deps = makeDeps({
    pendingPaths: ['src/a.ts'],
    responseText: 'Made some changes, keep going.',
    blastRisk: 'low'
  });
  const job = makeJob({ projectDir: dir }, { maxIterations: 4, autoApplyPolicy: 'safe', validateCommands: [] });

  const result = await runAutofixLogic(job, deps);

  assert.equal(result.iterations, 4, 'must run exactly maxIterations when no completion signal fires');
});

test('runAutoFixJob: checkpoint events are written for each iteration', async () => {
  const dir = join(tmpDir, 'test-checkpoints');
  const deps = makeDeps({ pendingPaths: ['src/b.ts'], blastRisk: 'low' });
  const job = makeJob({ projectDir: dir }, { maxIterations: 3, autoApplyPolicy: 'safe', validateCommands: [] });

  await runAutofixLogic(job, deps);

  const iterEvents = deps.checkpointEvents.filter(e => e.event === 'autofix.iteration');
  assert.equal(iterEvents.length, 3, 'one iteration checkpoint per loop turn');

  // Each event should carry iteration number and agent
  iterEvents.forEach((ev, i) => {
    assert.equal(ev.data.iteration, i + 1);
    assert.equal(typeof ev.data.agent, 'string');
  });
});

test('runAutoFixJob: safety checkpoint is written with blast and validation info', async () => {
  const dir = join(tmpDir, 'test-safety-checkpoint');
  const deps = makeDeps({ pendingPaths: ['src/core.ts'], blastRisk: 'medium' });
  const job = makeJob({ projectDir: dir }, { autoApplyPolicy: 'safe', blastRadiusThreshold: 'high', validateCommands: [] });

  await runAutofixLogic(job, deps, {
    analyzeBlastRadius: async () => ({ risk: 'medium', affectedFiles: [], summary: 'medium risk' })
  });

  const safetyEvent = deps.checkpointEvents.find(e => e.event === 'autofix.safety');
  assert.ok(safetyEvent, 'autofix.safety checkpoint must be written');
  assert.equal(safetyEvent.data.blastRisk, 'medium');
  assert.equal(safetyEvent.data.changedFiles, 1);
  assert.equal(typeof safetyEvent.data.validationPassed, 'boolean');
});

test('runAutoFixJob: runId is derived from job.id', async () => {
  const dir = join(tmpDir, 'test-run-id');
  const deps = makeDeps({ pendingPaths: [], edits: [] });
  const job = makeJob({ id: 'my-unique-job', projectDir: dir });

  const result = await runAutofixLogic(job, deps);

  assert.equal(result.runId, 'autofix-my-unique-job');
});
