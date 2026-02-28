import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { doctorMcpServers } from '../mcp/index.js';

const execFileAsync = promisify(execFile);

function parseMajorNodeVersion(version) {
  const cleaned = String(version || '').replace(/^v/, '');
  const major = Number.parseInt(cleaned.split('.')[0] || '0', 10);
  return Number.isNaN(major) ? 0 : major;
}

async function commandExists(command) {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

async function gatewayReachable(url) {
  try {
    const response = await fetch(`${url}/status`);
    return response.ok;
  } catch {
    return false;
  }
}

async function configExists() {
  const configPath = join(homedir(), '.crewswarm', 'config.json');
  try {
    await access(configPath, constants.F_OK);
    return { ok: true, path: configPath };
  } catch {
    return { ok: false, path: configPath };
  }
}

function parseVersionParts(version: string): number[] {
  const cleaned = String(version || '').trim().replace(/^v/, '').split('-')[0];
  return cleaned.split('.').map(part => Number.parseInt(part || '0', 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const av = parseVersionParts(a);
  const bv = parseVersionParts(b);
  const max = Math.max(av.length, bv.length);
  for (let i = 0; i < max; i += 1) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

export async function getInstalledCliVersion(): Promise<string | null> {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json')
  ];

  for (const candidate of candidates) {
    try {
      const raw = await (await import('node:fs/promises')).readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      const pkgName = String(parsed?.name || '');
      const looksLikeCli =
        pkgName === 'crewswarm-cli' ||
        pkgName === '@crewswarm/crew-cli' ||
        candidate.includes(`${join('crew-cli', 'package.json')}`);
      if (looksLikeCli && typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function getLatestCliVersion(tag = 'latest'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', `crewswarm-cli@${tag}`, 'version'], {
      timeout: 8000
    });
    const version = String(stdout || '').trim().split('\n').pop()?.trim();
    return version || null;
  } catch {
    return null;
  }
}

export async function isGlobalInstallLinked(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('npm', ['-g', 'ls', 'crewswarm-cli', '--depth=0']);
    return String(stdout || '').includes('->');
  } catch {
    return false;
  }
}

export async function runDoctorChecks(options = {}) {
  const gateway = options.gateway || 'http://localhost:5010';
  const nodeMajor = parseMajorNodeVersion(process.version);
  const gitOk = await commandExists('git');
  const gatewayOk = await gatewayReachable(gateway);
  const config = await configExists();
  const installedVersion = await getInstalledCliVersion();
  const latestVersion = await getLatestCliVersion(options.updateTag || 'latest');
  const linkedInstall = await isGlobalInstallLinked();
  const mcpChecks = await doctorMcpServers(process.cwd());

  let updateDetails = 'Update check unavailable';
  if (installedVersion && latestVersion) {
    const cmp = compareVersions(installedVersion, latestVersion);
    if (cmp < 0) {
      updateDetails = `Update available: ${installedVersion} -> ${latestVersion} (run "crew update")`;
    } else {
      updateDetails = `Up to date (${installedVersion})`;
    }
  }
  if (linkedInstall) {
    updateDetails += ' [global npm link detected]';
  }

  const mcpFailed = mcpChecks.filter(x => !x.ok).length;
  const mcpDetails = mcpFailed === 0 
    ? `All ${mcpChecks.length} servers online` 
    : `${mcpFailed}/${mcpChecks.length} servers failing`;

  return [
    {
      name: 'Node.js >= 20',
      ok: nodeMajor >= 20,
      details: `Detected ${process.version}`
    },
    {
      name: 'Git installed',
      ok: gitOk,
      details: gitOk ? 'git found in PATH' : 'git not found in PATH'
    },
    {
      name: 'CrewSwarm config present',
      ok: config.ok,
      details: config.path
    },
    {
      name: 'CrewSwarm gateway reachable',
      ok: gatewayOk,
      details: `${gateway}/status`
    },
    {
      name: 'MCP configuration health',
      ok: mcpFailed === 0,
      details: mcpDetails
    },
    {
      name: 'CLI update status',
      ok: true,
      details: updateDetails
    }
  ];
}

export function summarizeDoctorResults(results) {
  const passed = results.filter(item => item.ok).length;
  const failed = results.length - passed;
  return { passed, failed };
}
