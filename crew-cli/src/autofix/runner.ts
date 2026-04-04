// @ts-nocheck
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRouter } from '../agent/router.js';
import { analyzeBlastRadius, isSeverityAtLeast } from '../blast-radius/index.js';
import type { CheckpointStore } from '../checkpoint/store.js';
import type { Logger } from '../utils/logger.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Sandbox } from '../sandbox/index.js';
import type { SessionManager } from '../session/manager.js';
import { scorePatchRisk } from '../risk/score.js';
import type { AutoFixJob } from './store.js';

function hasCompletionSignal(text: string): boolean {
  const lower = text.toLowerCase();
  const signals = [
    'task complete',
    'task is complete',
    'implementation complete',
    'all done',
    'finished',
    'successfully implemented',
    'no further changes needed',
    'ready for review'
  ];
  return signals.some(signal => lower.includes(signal));
}

function shouldRetryWithFallback(error: unknown): boolean {
  const text = String((error as Error)?.message || '').toLowerCase();
  return (
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes('timeout') ||
    text.includes('empty') ||
    text.includes('temporar') ||
    text.includes('unavailable') ||
    text.includes('quota')
  );
}

async function dispatchWithFallback(
  router: AgentRouter,
  agent: string,
  task: string,
  options: Record<string, unknown>,
  fallbackModels: string[] = [],
  checkpoints?: CheckpointStore,
  runId?: string
) {
  const tried: string[] = [];
  const primary = String(options.model || '').trim();
  if (primary) tried.push(primary);
  const chain = [primary, ...fallbackModels].map(v => String(v || '').trim()).filter(Boolean);
  if (chain.length === 0) {
    const result = await router.dispatch(agent, task, options);
    return { result, usedModel: primary || 'default', attempts: tried };
  }

  let lastError: Error | null = null;
  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    try {
      if (checkpoints && runId) {
        await checkpoints.append(runId, 'autofix.dispatch.model.attempt', { model, index: i + 1 });
      }
      const result = await router.dispatch(agent, task, {
        ...options,
        model
      });
      if (checkpoints && runId) {
        await checkpoints.append(runId, 'autofix.dispatch.model.success', { model, index: i + 1 });
      }
      return { result, usedModel: model, attempts: [...tried, model] };
    } catch (error) {
      lastError = error as Error;
      tried.push(model);
      if (checkpoints && runId) {
        await checkpoints.append(runId, 'autofix.dispatch.model.failed', {
          model,
          error: String((error as Error).message || error)
        });
      }
      const canRetry = i < chain.length - 1 && shouldRetryWithFallback(error);
      if (!canRetry) break;
    }
  }

  throw lastError || new Error(`Dispatch failed for ${agent}`);
}

function runValidationCommands(commands: string[] = [], cwd = process.cwd()) {
  if (!commands.length) return { passed: true, failedCommand: '', output: '' };
  for (const cmd of commands) {
    try {
      execSync(cmd, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024
      });
    } catch (error) {
      return {
        passed: false,
        failedCommand: cmd,
        output: String((error as any)?.stderr || (error as Error).message || '')
      };
    }
  }
  return { passed: true, failedCommand: '', output: '' };
}

async function runLspAutoFixCycle(
  projectDir: string,
  maxAttempts: number,
  options: {
    router: AgentRouter;
    orchestrator: Orchestrator;
    sessionId: string;
    gateway?: string;
    model?: string;
    fallbackModels: string[];
    checkpoints?: CheckpointStore;
    runId?: string;
    logger: Logger;
  }
): Promise<{ fixed: boolean; attempts: number; remainingDiagnostics: number }> {
  const { typeCheckProject } = await import('../lsp/index.js');
  const cappedAttempts = Math.max(1, maxAttempts);
  let diagnostics = await typeCheckProject(projectDir, []);
  if (diagnostics.length === 0) return { fixed: true, attempts: 0, remainingDiagnostics: 0 };

  let attempts = 0;
  while (attempts < cappedAttempts && diagnostics.length > 0) {
    attempts += 1;
    const summary = diagnostics
      .slice(0, 30)
      .map(d => `${d.file}:${d.line}:${d.column} [${d.category}] TS${d.code} ${d.message}`)
      .join('\n');
    const task = [
      'Fix TypeScript diagnostics with minimal safe edits.',
      'Diagnostics:',
      summary
    ].join('\n');

    const dispatched = await dispatchWithFallback(
      options.router,
      'crew-fixer',
      task,
      {
        project: projectDir,
        sessionId: options.sessionId,
        gateway: options.gateway,
        model: options.model
      },
      options.fallbackModels,
      options.checkpoints,
      options.runId
    );
    const response = String(dispatched.result?.result || '');
    const edits = await options.orchestrator.parseAndApplyToSandbox(response);
    options.logger.info(`Autofix LSP pass ${attempts}: ${diagnostics.length} diagnostics, ${edits.length} edit(s).`);
    await options.checkpoints?.append(String(options.runId || ''), 'autofix.lsp.attempt', {
      attempt: attempts,
      diagnostics: diagnostics.length,
      edits: edits.length
    });
    diagnostics = await typeCheckProject(projectDir, []);
  }

  return {
    fixed: diagnostics.length === 0,
    attempts,
    remainingDiagnostics: diagnostics.length
  };
}

export interface AutoFixRunDependencies {
  router: AgentRouter;
  orchestrator: Orchestrator;
  sandbox: Sandbox;
  session: SessionManager;
  logger: Logger;
  checkpoints: CheckpointStore;
}

export interface AutoFixRunResult {
  runId: string;
  iterations: number;
  editedFiles: string[];
  applied: boolean;
  proposalPath?: string;
  blastRisk?: 'low' | 'medium' | 'high';
  patchRiskLevel?: 'low' | 'medium' | 'high';
  patchRiskScore?: number;
  validationPassed?: boolean;
  validationFailedCommand?: string;
}

export async function runAutoFixJob(job: AutoFixJob, deps: AutoFixRunDependencies): Promise<AutoFixRunResult> {
  const { router, orchestrator, sandbox, session, logger, checkpoints } = deps;
  const runId = `autofix-${job.id}`;
  const activeBranch = sandbox.getActiveBranch();
  if (sandbox.hasChanges(activeBranch)) {
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

      const dispatched = await dispatchWithFallback(
        router,
        agent,
        currentTask,
        {
          project: job.projectDir,
          sessionId: await session.getSessionId(),
          gateway: job.config.gateway,
          model: job.config.model
        },
        job.config.fallbackModels,
        checkpoints,
        runId
      );

      const responseText = String(dispatched.result?.result || '');
      const edits = await orchestrator.parseAndApplyToSandbox(responseText);
      await checkpoints.append(runId, 'autofix.iteration', {
        iteration,
        agent,
        edits: edits.length,
        success: Boolean(dispatched.result?.success)
      });
      await session.appendHistory({
        type: 'autofix_iteration',
        jobId: job.id,
        iteration,
        agent,
        success: Boolean(dispatched.result?.success),
        edits: edits.length
      });

      if (edits.length > 0 && job.config.lspAutoFix) {
        await runLspAutoFixCycle(job.projectDir, job.config.lspAutoFixMaxAttempts, {
          router,
          orchestrator,
          sessionId: await session.getSessionId(),
          gateway: job.config.gateway,
          model: job.config.model,
          fallbackModels: job.config.fallbackModels,
          checkpoints,
          runId,
          logger
        });
      }

      if (hasCompletionSignal(responseText)) {
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
      return {
        runId,
        iterations: iteration,
        editedFiles: [],
        applied: false
      };
    }

    const validation = runValidationCommands(job.config.validateCommands, job.projectDir);
    const blast = await analyzeBlastRadius(job.projectDir, { changedFiles: editedFiles });
    const patchRisk = scorePatchRisk({
      blastRadius: blast,
      changedFiles: editedFiles.length,
      validationPassed: validation.passed
    });

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
      await checkpoints.append(runId, 'autofix.applied', {
        policy: job.config.autoApplyPolicy,
        files: editedFiles
      });
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
    try {
      await sandbox.rollback(sandbox.getActiveBranch());
    } catch {
      // Best-effort cleanup for failed background jobs.
    }
    await checkpoints.append(runId, 'autofix.error', {
      error: String((error as Error).message || error),
      iteration
    });
    await checkpoints.finish(runId, 'failed');
    throw error;
  }
}
