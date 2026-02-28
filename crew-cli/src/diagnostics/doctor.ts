import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

export async function runDoctorChecks(options = {}) {
  const gateway = options.gateway || 'http://localhost:5010';
  const nodeMajor = parseMajorNodeVersion(process.version);
  const gitOk = await commandExists('git');
  const gatewayOk = await gatewayReachable(gateway);
  const config = await configExists();

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
    }
  ];
}

export function summarizeDoctorResults(results) {
  const passed = results.filter(item => item.ok).length;
  const failed = results.length - passed;
  return { passed, failed };
}
