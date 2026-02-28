import { spawn } from 'node:child_process';

export interface SrcCommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function runSrcCli(args: string[], cwd = process.cwd()): Promise<SrcCommandResult> {
  return new Promise(resolve => {
    const child = spawn('src', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    child.on('error', error => {
      resolve({
        success: false,
        code: 1,
        stdout,
        stderr: `${stderr}${error.message}`
      });
    });

    child.on('close', code => {
      resolve({
        success: code === 0,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}
