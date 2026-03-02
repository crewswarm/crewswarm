import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutionPolicy, isRetryableError, isRiskBlocked, withRetries } from '../runtime/execution-policy.js';
import { analyzeBlastRadius } from '../blast-radius/index.js';

interface HeadlessDeps {
  router: any;
  orchestrator: any;
  sandbox: any;
  session: any;
}

interface HeadlessRunOptions extends HeadlessDeps {
  task: string;
  projectDir?: string;
  agent?: string;
  gateway?: string;
  json?: boolean;
  alwaysApprove?: boolean;
  forceAutoApply?: boolean;
  riskThreshold?: 'low' | 'medium' | 'high';
  retryAttempts?: number;
  fallbackModels?: string[];
  out?: string;
}

function statePath(baseDir: string): string {
  return join(baseDir, '.crew', 'headless-state.json');
}

async function ensureState(baseDir: string): Promise<void> {
  const path = statePath(baseDir);
  await mkdir(join(baseDir, '.crew'), { recursive: true });
  if (!existsSync(path)) {
    await writeFile(path, JSON.stringify({ paused: false, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }
}

export async function getHeadlessState(baseDir = process.cwd()): Promise<{ paused: boolean; updatedAt?: string }> {
  await ensureState(baseDir);
  try {
    const raw = await readFile(statePath(baseDir), 'utf8');
    const parsed = JSON.parse(raw);
    return { paused: Boolean(parsed.paused), updatedAt: parsed.updatedAt };
  } catch {
    return { paused: false };
  }
}

export async function setHeadlessPaused(paused: boolean, baseDir = process.cwd()): Promise<void> {
  await ensureState(baseDir);
  await writeFile(
    statePath(baseDir),
    JSON.stringify({ paused: Boolean(paused), updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

async function appendOutLine(baseDir: string, outPath: string | undefined, payload: any): Promise<void> {
  if (!outPath) return;
  const fullPath = join(baseDir, outPath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  const prev = existsSync(fullPath) ? await readFile(fullPath, 'utf8') : '';
  await writeFile(fullPath, `${prev}${JSON.stringify(payload)}\n`, 'utf8');
}

async function emit(baseDir: string, jsonMode: boolean, outPath: string | undefined, event: string, data: any = {}): Promise<void> {
  const payload = { ts: new Date().toISOString(), event, ...data };
  await appendOutLine(baseDir, outPath, payload);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const suffix = data?.message ? `: ${data.message}` : '';
  console.log(`[headless] ${event}${suffix}`);
}

export async function runHeadlessTask(options: HeadlessRunOptions): Promise<{ success: boolean; response?: string }> {
  const cwd = options.projectDir || process.cwd();
  const jsonMode = Boolean(options.json);
  const state = await getHeadlessState(cwd);

  if (state.paused) {
    await emit(cwd, jsonMode, options.out, 'blocked', { message: 'headless mode is paused' });
    return { success: false };
  }

  await emit(cwd, jsonMode, options.out, 'start', { task: options.task });

  const policy = getExecutionPolicy({
    retryAttempts: Number(options.retryAttempts || 2),
    riskThreshold: options.riskThreshold || 'high',
    forceAutoApply: Boolean(options.forceAutoApply)
  });

  const route = await withRetries(
    async () => options.orchestrator.route(options.task),
    policy
  );
  const agent = options.agent || route.agent || 'crew-main';
  await emit(cwd, jsonMode, options.out, 'route', { decision: route.decision, agent });

  const fallbackChain = (options.fallbackModels || []).map(v => String(v || '').trim()).filter(Boolean);
  const chain = fallbackChain.length > 0 ? fallbackChain : [''];
  let dispatch: any = null;
  let lastError: unknown = null;
  for (const model of chain) {
    try {
      dispatch = await withRetries(
        async () => options.router.dispatch(agent, options.task, {
          sessionId: await options.session.getSessionId(),
          project: cwd,
          gateway: options.gateway,
          model: model || undefined
        }),
        policy,
        { shouldRetry: isRetryableError }
      );
      if (dispatch) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!dispatch) {
    throw (lastError as Error) || new Error('Headless dispatch failed');
  }

  const responseText = String(dispatch.result || '');
  await emit(cwd, jsonMode, options.out, 'result', { agent, response: responseText });

  const edits = await options.orchestrator.parseAndApplyToSandbox(responseText);
  await emit(cwd, jsonMode, options.out, 'sandbox', { filesChanged: edits.length });

  if (options.alwaysApprove && options.sandbox.hasChanges(options.sandbox.getActiveBranch())) {
    const active = options.sandbox.getActiveBranch();
    const changedFiles = typeof options.sandbox.getPendingPaths === 'function'
      ? options.sandbox.getPendingPaths(active)
      : [];
    const report = await analyzeBlastRadius(cwd, { changedFiles });
    if (isRiskBlocked(report.risk, policy.riskThreshold, policy.forceAutoApply)) {
      await emit(cwd, jsonMode, options.out, 'approval_required', {
        message: `risk gate blocked auto-apply (${report.risk} >= ${policy.riskThreshold})`
      });
      return { success: false, response: responseText };
    }
    await options.sandbox.apply(active);
    await emit(cwd, jsonMode, options.out, 'applied', { message: 'sandbox changes applied (--always-approve)' });
  } else if (edits.length > 0) {
    await emit(cwd, jsonMode, options.out, 'approval_required', { message: 'pending sandbox changes require apply' });
  }

  await emit(cwd, jsonMode, options.out, 'done', { success: true });
  return { success: true, response: responseText };
}
