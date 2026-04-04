import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface McpServerConfig {
  url: string;
  bearerTokenEnvVar?: string;
  headers?: Record<string, string>;
}

interface McpStore {
  mcpServers: Record<string, McpServerConfig>;
}

function localStorePath(baseDir = process.cwd()): string {
  return join(baseDir, '.crew', 'mcp-servers.json');
}

function clientPath(client: string): string {
  const home = homedir();
  const key = String(client || '').toLowerCase();
  if (key === 'cursor') return join(home, '.cursor', 'mcp.json');
  if (key === 'claude') return join(home, '.claude', 'mcp.json');
  if (key === 'opencode') return join(home, '.config', 'opencode', 'mcp.json');
  if (key === 'codex') return join(home, '.codex', 'mcp', 'config.json');
  throw new Error(`Unsupported client: ${client}`);
}

function isCodexClient(client: string): boolean {
  return String(client || '').toLowerCase() === 'codex';
}

function syncServerToCodex(name: string, config: McpServerConfig): void {
  const extraHeaders = Object.entries(config.headers || {}).filter(
    ([key]) => key.toLowerCase() !== 'authorization'
  );
  if (extraHeaders.length > 0) {
    throw new Error(
      `Codex MCP sync does not support custom headers: ${extraHeaders.map(([key]) => key).join(', ')}`
    );
  }

  const args = ['mcp', 'add', name, '--url', config.url];
  if (config.bearerTokenEnvVar) {
    args.push('--bearer-token-env-var', config.bearerTokenEnvVar);
  } else if ((config.headers || {}).Authorization || (config.headers || {}).authorization) {
    throw new Error(
      'Codex MCP sync requires --bearer-token-env-var for authenticated HTTP servers'
    );
  }

  execFileSync('codex', args, { stdio: 'ignore' });
}

function removeServerFromCodex(name: string): void {
  execFileSync('codex', ['mcp', 'remove', name], { stdio: 'ignore' });
}

async function loadStore(path: string): Promise<McpStore> {
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return { mcpServers: parsed.mcpServers || {} };
  } catch {
    return { mcpServers: {} };
  }
}

async function saveStore(path: string, store: McpStore): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function listMcpServers(baseDir = process.cwd()): Promise<Record<string, McpServerConfig>> {
  const store = await loadStore(localStorePath(baseDir));
  return store.mcpServers;
}

export async function addMcpServer(
  name: string,
  config: McpServerConfig,
  baseDir = process.cwd(),
  client?: string
): Promise<void> {
  if (!name || !config?.url) {
    throw new Error('name and url are required');
  }

  const localPath = localStorePath(baseDir);
  const store = await loadStore(localPath);
  store.mcpServers[name] = {
    url: config.url,
    bearerTokenEnvVar: config.bearerTokenEnvVar || undefined,
    headers: config.headers || undefined
  };
  await saveStore(localPath, store);

  if (client) {
    await syncServerToClient(name, store.mcpServers[name], client);
  }
}

export async function removeMcpServer(name: string, baseDir = process.cwd(), client?: string): Promise<void> {
  if (!name) throw new Error('name is required');

  const localPath = localStorePath(baseDir);
  const store = await loadStore(localPath);
  delete store.mcpServers[name];
  await saveStore(localPath, store);

  if (client) {
    if (isCodexClient(client)) {
      removeServerFromCodex(name);
      return;
    }
    const path = clientPath(client);
    const clientStore = await loadStore(path);
    delete clientStore.mcpServers[name];
    await saveStore(path, clientStore);
  }
}

export async function syncServerToClient(name: string, config: McpServerConfig, client: string): Promise<void> {
  if (isCodexClient(client)) {
    syncServerToCodex(name, config);
    return;
  }
  const path = clientPath(client);
  const store = await loadStore(path);
  const payload: McpServerConfig = { url: config.url };

  if (config.headers && Object.keys(config.headers).length) {
    payload.headers = config.headers;
  }
  if (config.bearerTokenEnvVar) {
    payload.bearerTokenEnvVar = config.bearerTokenEnvVar;
  }

  store.mcpServers[name] = payload;
  await saveStore(path, store);
}

export interface McpDoctorCheck {
  server: string;
  ok: boolean;
  details: string;
}

export async function doctorMcpServers(baseDir = process.cwd()): Promise<McpDoctorCheck[]> {
  const checks: McpDoctorCheck[] = [];
  const servers = await listMcpServers(baseDir);
  const names = Object.keys(servers);

  if (!names.length) {
    return [{ server: '(none)', ok: false, details: 'No MCP servers configured' }];
  }

  for (const name of names) {
    const server = servers[name];
    if (!server?.url) {
      checks.push({ server: name, ok: false, details: 'Missing URL' });
      continue;
    }

    try {
      // URL format validation
      new URL(server.url);
    } catch {
      checks.push({ server: name, ok: false, details: `Invalid URL: ${server.url}` });
      continue;
    }

    if (server.bearerTokenEnvVar && !process.env[server.bearerTokenEnvVar]) {
      checks.push({
        server: name,
        ok: false,
        details: `Missing env var ${server.bearerTokenEnvVar}`
      });
      continue;
    }

    try {
      const res = await fetch(server.url, {
        method: 'GET',
        signal: AbortSignal.timeout(2500)
      });
      checks.push({
        server: name,
        ok: res.ok,
        details: `HTTP ${res.status}`
      });
    } catch (error) {
      checks.push({
        server: name,
        ok: false,
        details: `Unreachable: ${(error as Error).message}`
      });
    }
  }

  return checks;
}
