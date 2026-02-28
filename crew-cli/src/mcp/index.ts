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
  throw new Error(`Unsupported client: ${client}`);
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
    const path = clientPath(client);
    const clientStore = await loadStore(path);
    delete clientStore.mcpServers[name];
    await saveStore(path, clientStore);
  }
}

export async function syncServerToClient(name: string, config: McpServerConfig, client: string): Promise<void> {
  const path = clientPath(client);
  const store = await loadStore(path);
  const payload: any = { url: config.url };

  if (config.headers && Object.keys(config.headers).length) {
    payload.headers = config.headers;
  }
  if (config.bearerTokenEnvVar) {
    payload.bearerTokenEnvVar = config.bearerTokenEnvVar;
  }

  store.mcpServers[name] = payload;
  await saveStore(path, store);
}
