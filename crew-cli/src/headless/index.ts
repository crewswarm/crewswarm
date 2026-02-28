import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  json?: boolean;
  alwaysApprove?: boolean;
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

function emit(jsonMode: boolean, event: string, data: any = {}): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
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
    emit(jsonMode, 'blocked', { message: 'headless mode is paused' });
    return { success: false };
  }

  emit(jsonMode, 'start', { task: options.task });

  const route = await options.orchestrator.route(options.task);
  const agent = options.agent || route.agent || 'crew-main';
  emit(jsonMode, 'route', { decision: route.decision, agent });

  const dispatch = await options.router.dispatch(agent, options.task, {
    sessionId: await options.session.getSessionId(),
    project: cwd
  });

  const responseText = String(dispatch.result || '');
  emit(jsonMode, 'result', { agent, response: responseText });

  const edits = await options.orchestrator.parseAndApplyToSandbox(responseText);
  emit(jsonMode, 'sandbox', { filesChanged: edits.length });

  if (options.alwaysApprove && options.sandbox.hasChanges(options.sandbox.getActiveBranch())) {
    await options.sandbox.apply(options.sandbox.getActiveBranch());
    emit(jsonMode, 'applied', { message: 'sandbox changes applied (--always-approve)' });
  } else if (edits.length > 0) {
    emit(jsonMode, 'approval_required', { message: 'pending sandbox changes require apply' });
  }

  emit(jsonMode, 'done', { success: true });
  return { success: true, response: responseText };
}
