#!/usr/bin/env node

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const binPath = path.join(repoRoot, 'bin', 'crew.js');

async function runCommand(args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    child.on('close', code => {
      resolve({
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function assertExpected(name, result, expectedCode, requiredPattern) {
  if (result.code !== expectedCode) {
    throw new Error(
      `[smoke] ${name} expected exit ${expectedCode}, got ${result.code}\n` +
      `STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`
    );
  }
  if (requiredPattern) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (!requiredPattern.test(text)) {
      throw new Error(
        `[smoke] ${name} expected output pattern ${requiredPattern}\n` +
        `STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`
      );
    }
  }
}

async function main() {
  const sandboxDir = await mkdtemp(path.join(tmpdir(), 'crew-cli-smoke-'));
  const cases = [
    { name: 'help', args: ['--help'], code: 0, match: /Usage:/i },
    { name: 'status', args: ['status'], code: 0 },
    { name: 'list', args: ['list'], code: 0 },
    { name: 'mcp list', args: ['mcp', 'list'], code: 0 },
    { name: 'headless status', args: ['headless', 'status'], code: 0 },
    { name: 'context', args: ['context'], code: 0 },
    {
      name: 'chat budget-stop failure contract',
      args: ['chat', 'hello', '--max-context-tokens', '1', '--context-budget-mode', 'stop'],
      code: 1,
      match: /Context budget exceeded/i
    },
    {
      name: 'dispatch unreachable gateway contract',
      args: ['dispatch', 'crew-main', 'hello', '--skip-cost-check', '--timeout', '1000', '--gateway', 'http://127.0.0.1:1'],
      code: 1,
      match: /Dispatch failed|ECONNREFUSED|fetch failed|Failed to parse/i
    },
    {
      name: 'doctor unreachable gateway contract',
      args: ['doctor', '--gateway', 'http://127.0.0.1:1'],
      code: 1
    }
  ];

  for (const testCase of cases) {
    const result = await runCommand(testCase.args, { cwd: sandboxDir });
    assertExpected(testCase.name, result, testCase.code, testCase.match);
    console.log(`[smoke] PASS ${testCase.name}`);
  }

  console.log('[smoke] PASS: command contract checks completed.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

