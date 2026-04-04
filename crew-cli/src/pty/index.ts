import { spawn as spawnChild } from 'node:child_process';

export interface PtyRunOptions {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
}

export interface PtyRunResult {
  success: boolean;
  exitCode: number;
  signal: string | null;
  output: string;
}

interface PtyProcessLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (info: { exitCode: number; signal: number }) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyPackageLike {
  spawn(
    file: string,
    args: string | string[],
    options: {
      name: string;
      cwd: string;
      cols: number;
      rows: number;
      env: NodeJS.ProcessEnv;
    }
  ): PtyProcessLike;
}

export async function runPtyCommand(command: string, options: PtyRunOptions = {}): Promise<PtyRunResult> {
  if (!command || !String(command).trim()) {
    throw new Error('PTY command is required');
  }

  let ptyPackage: PtyPackageLike | null = null;
  try {
    const mod = await import('node-pty') as { spawn?: PtyPackageLike['spawn']; default?: PtyPackageLike };
    ptyPackage = mod.default || (mod.spawn ? { spawn: mod.spawn } : null);
  } catch {
    ptyPackage = null;
  }

  if (ptyPackage?.spawn) {
    try {
      return await runWithNodePty(command, options, ptyPackage);
    } catch {
      return runWithInherit(command, options);
    }
  }
  return runWithInherit(command, options);
}

async function runWithNodePty(command: string, options: PtyRunOptions, ptyPackage: PtyPackageLike): Promise<PtyRunResult> {
  return new Promise(resolve => {
    const shell = options.shell || process.env.SHELL || '/bin/bash';
    const pty = ptyPackage.spawn(shell, ['-lc', command], {
      name: 'xterm-color',
      cwd: options.cwd || process.cwd(),
      cols: options.cols || process.stdout.columns || 120,
      rows: options.rows || process.stdout.rows || 30,
      env: process.env
    });

    let output = '';
    let done = false;

    const timeoutMs = options.timeoutMs || 0;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (done) return;
          done = true;
          pty.kill();
          resolve({ success: false, exitCode: -1, signal: 'SIGTERM', output });
        }, timeoutMs)
      : null;

    const onData = (data: string) => {
      output += data;
      process.stdout.write(data);
    };
    pty.onData(onData);

    const onResize = () => {
      const cols = process.stdout.columns || 120;
      const rows = process.stdout.rows || 30;
      try {
        pty.resize(cols, rows);
      } catch {
        // Ignore resize failures.
      }
    };
    process.stdout.on('resize', onResize);

    pty.onExit(({ exitCode, signal }: { exitCode: number; signal: number }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      process.stdout.off('resize', onResize);
      resolve({
        success: exitCode === 0,
        exitCode,
        signal: signal ? String(signal) : null,
        output
      });
    });
  });
}

async function runWithInherit(command: string, options: PtyRunOptions): Promise<PtyRunResult> {
  return new Promise(resolve => {
    const shell = options.shell || process.env.SHELL || '/bin/bash';
    const child = spawnChild(shell, ['-lc', command], {
      cwd: options.cwd || process.cwd(),
      stdio: 'inherit'
    });

    const timeoutMs = options.timeoutMs || 0;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        success: (code ?? -1) === 0,
        exitCode: code ?? -1,
        signal: signal ?? null,
        output: ''
      });
    });
  });
}
