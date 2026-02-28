import { spawn } from 'node:child_process';

export interface EngineRunOptions {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface EngineRunResult {
  success: boolean;
  engine: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCommand(command: string, args: string[], options: EngineRunOptions = {}): Promise<EngineRunResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timeoutMs = options.timeoutMs || 300000;
    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      child.kill('SIGTERM');
      done = true;
      resolve({
        success: false,
        engine: command,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`,
        exitCode: -1
      });
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        success: code === 0,
        engine: command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1
      });
    });
  });
}

async function callJsonApi(url: string, apiKey: string | null, body: unknown): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json() as any;
  return data?.content?.[0]?.text
    || data?.candidates?.[0]?.content?.parts?.[0]?.text
    || data?.output_text
    || JSON.stringify(data);
}

export async function runGeminiApi(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    return {
      success: false,
      engine: 'gemini-api',
      stdout: '',
      stderr: 'Missing GEMINI_API_KEY/GOOGLE_API_KEY',
      exitCode: 1
    };
  }

  const model = options.model || 'gemini-2.0-flash';
  try {
    const text = await callJsonApi(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      null,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    return { success: true, engine: 'gemini-api', stdout: text, stderr: '', exitCode: 0 };
  } catch (error) {
    return { success: false, engine: 'gemini-api', stdout: '', stderr: (error as Error).message, exitCode: 1 };
  }
}

export async function runClaudeApi(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      success: false,
      engine: 'claude-api',
      stdout: '',
      stderr: 'Missing ANTHROPIC_API_KEY',
      exitCode: 1
    };
  }

  const model = options.model || 'claude-3-5-sonnet-latest';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text.slice(0, 500)}`);
    }
    const data = await response.json() as any;
    const text = data?.content?.[0]?.text || JSON.stringify(data);
    return { success: true, engine: 'claude-api', stdout: text, stderr: '', exitCode: 0 };
  } catch (error) {
    return { success: false, engine: 'claude-api', stdout: '', stderr: (error as Error).message, exitCode: 1 };
  }
}

export async function runGeminiCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  return runCommand('gemini', ['-p', prompt, '--output-format', 'stream-json'], options);
}

export async function runCodexCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  return runCommand('codex', ['exec', '--sandbox', 'workspace-write', '--json', prompt], options);
}

export async function runClaudeCli(prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  return runCommand('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', prompt], options);
}

export async function runEngine(engine: string, prompt: string, options: EngineRunOptions = {}): Promise<EngineRunResult> {
  switch (engine) {
    case 'gemini-api':
      return runGeminiApi(prompt, options);
    case 'claude-api':
      return runClaudeApi(prompt, options);
    case 'gemini-cli':
      return runGeminiCli(prompt, options);
    case 'codex-cli':
      return runCodexCli(prompt, options);
    case 'claude-cli':
      return runClaudeCli(prompt, options);
    default:
      return {
        success: false,
        engine,
        stdout: '',
        stderr: `Unknown engine "${engine}"`,
        exitCode: 1
      };
  }
}
