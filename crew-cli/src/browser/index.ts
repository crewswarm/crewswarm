import { spawn, ChildProcess } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findChromeExecutable(): Promise<string | null> {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'chrome'
  ];

  for (const candidate of candidates) {
    if (candidate.startsWith('/')) {
      if (await exists(candidate)) return candidate;
      continue;
    }
    try {
      const { stdout } = await execFileAsync('which', [candidate]);
      const bin = stdout.trim();
      if (bin) return bin;
    } catch {
      // continue
    }
  }
  return null;
}

export async function launchChromeDebug(url: string, port = 9222): Promise<ChildProcess> {
  const chrome = await findChromeExecutable();
  if (!chrome) {
    throw new Error('Chrome/Chromium binary not found. Set CHROME_BIN or install Chrome.');
  }

  const userDataDir = join(tmpdir(), `crew-browser-debug-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    url
  ];

  const proc = spawn(chrome, args, { stdio: 'ignore' });
  return proc;
}

export type CdpEventHandler = (params: any) => void;

export class CdpClient {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, (value: any) => void>();
  handlers = new Map<string, CdpEventHandler[]>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => {
      const payload = JSON.parse(String(data));
      if (payload.id && this.pending.has(payload.id)) {
        this.pending.get(payload.id)?.(payload);
        this.pending.delete(payload.id);
      } else if (payload.method && this.handlers.has(payload.method)) {
        for (const handler of this.handlers.get(payload.method) || []) {
          handler(payload.params || {});
        }
      }
    });
  }

  send(method: string, params: any = {}) {
    const id = ++this.id;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }), err => {
        if (err) reject(err);
      });
    });
  }

  on(method: string, handler: CdpEventHandler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }
}

export interface BrowserDebugResult {
  consoleErrors: string[];
  screenshotPath?: string;
}

export async function getPageWsUrl(port: number, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const targets = await res.json() as any[];
        const page = targets.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for Chrome Page target.');
}

export async function waitForWsDebuggerUrl(port: number, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for Chrome DevTools endpoint.');
}

export async function runBrowserDebug(url: string, options: { port?: number; durationMs?: number; screenshotPath?: string } = {}): Promise<BrowserDebugResult> {
  const port = options.port || 9222;
  const durationMs = options.durationMs || 5000;
  const proc = await launchChromeDebug(url, port);
  let ws: WebSocket | null = null;

  try {
    const wsUrl = await waitForWsDebuggerUrl(port);
    ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws?.once('open', () => resolve());
      ws?.once('error', reject);
    });

    const client = new CdpClient(ws);
    const errors: string[] = [];

    client.on('Runtime.consoleAPICalled', params => {
      const level = params.type || 'log';
      if (level === 'error' || level === 'warning') {
        const text = (params.args || []).map((a: any) => a.value || a.description || '').join(' ');
        errors.push(`[console:${level}] ${text}`.trim());
      }
    });

    client.on('Runtime.exceptionThrown', params => {
      const desc = params.exceptionDetails?.text || 'Exception thrown';
      errors.push(`[exception] ${desc}`);
    });

    client.on('Log.entryAdded', params => {
      const level = params.entry?.level || 'info';
      if (level === 'error' || level === 'warning') {
        errors.push(`[log:${level}] ${params.entry?.text || ''}`.trim());
      }
    });

    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    await new Promise(resolve => setTimeout(resolve, durationMs));

    let screenshotPath = options.screenshotPath;
    const screenshotRes = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!screenshotPath) {
      screenshotPath = join(process.cwd(), '.crew', `browser-shot-${Date.now()}.png`);
    }
    await writeFile(screenshotPath, Buffer.from(screenshotRes.result?.data || screenshotRes.data, 'base64'));

    return { consoleErrors: errors, screenshotPath };
  } finally {
    try {
      ws?.close();
    } catch (e) {
      console.error(`Failed to close WebSocket: ${e.message}`);
    }
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      console.error(`Failed to kill browser process: ${e.message}`);
    }
  }
}

export function compareScreenshotBuffers(a: Buffer, b: Buffer) {
  const max = Math.max(a.length, b.length);
  if (max === 0) return { diffBytes: 0, diffPercent: 0 };
  let diff = 0;
  for (let i = 0; i < max; i++) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    if (av !== bv) diff++;
  }
  return {
    diffBytes: diff,
    diffPercent: (diff / max) * 100
  };
}

export async function compareScreenshots(pathA: string, pathB: string) {
  const [a, b] = await Promise.all([readFile(pathA), readFile(pathB)]);
  return compareScreenshotBuffers(a, b);
}
