// @ts-nocheck
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface PrivacyControls {
  sharePrompt: boolean;
  shareOriginal: boolean;
  shareCorrected: boolean;
  shareTags: boolean;
}

const DEFAULT_PRIVACY: PrivacyControls = {
  sharePrompt: true,
  shareOriginal: true,
  shareCorrected: true,
  shareTags: true
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getStateDir(baseDir = process.cwd()) {
  return join(baseDir, '.crew');
}

function getTeamSyncDir(baseDir = process.cwd()) {
  return process.env.TEAM_SYNC_DIR || join(getStateDir(baseDir), 'team-sync');
}

function getPrivacyPath(baseDir = process.cwd()) {
  return join(getStateDir(baseDir), 'privacy.json');
}

function applyPrivacyToCorrection(entry: any, privacy: PrivacyControls) {
  const output: any = {
    timestamp: entry.timestamp,
    agent: entry.agent || null
  };
  if (privacy.sharePrompt) output.prompt = entry.prompt;
  if (privacy.shareOriginal) output.original = entry.original;
  if (privacy.shareCorrected) output.corrected = entry.corrected;
  if (privacy.shareTags) output.tags = entry.tags || [];
  return output;
}

export async function loadPrivacyControls(baseDir = process.cwd()): Promise<PrivacyControls> {
  const path = getPrivacyPath(baseDir);
  if (!(await exists(path))) {
    await mkdir(getStateDir(baseDir), { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_PRIVACY, null, 2), 'utf8');
    return { ...DEFAULT_PRIVACY };
  }

  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      sharePrompt: parsed.sharePrompt !== false,
      shareOriginal: parsed.shareOriginal !== false,
      shareCorrected: parsed.shareCorrected !== false,
      shareTags: parsed.shareTags !== false
    };
  } catch {
    return { ...DEFAULT_PRIVACY };
  }
}

export async function savePrivacyControls(privacy: PrivacyControls, baseDir = process.cwd()) {
  await mkdir(getStateDir(baseDir), { recursive: true });
  await writeFile(getPrivacyPath(baseDir), JSON.stringify(privacy, null, 2), 'utf8');
}

export async function uploadTeamContext(baseDir = process.cwd()) {
  const stateDir = getStateDir(baseDir);
  const teamDir = getTeamSyncDir(baseDir);
  await mkdir(teamDir, { recursive: true });

  const sessionPath = join(stateDir, 'session.json');
  const correctionsPath = join(stateDir, 'training-data.jsonl');
  const host = hostname().replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionOut = join(teamDir, `${host}-session.json`);
  const correctionsOut = join(teamDir, `${host}-training-data.jsonl`);

  if (await exists(sessionPath)) {
    if (process.env.TEAM_S3_SESSION_PUT_URL) {
      const body = await readFile(sessionPath, 'utf8');
      await fetch(process.env.TEAM_S3_SESSION_PUT_URL, { method: 'PUT', body });
    }
    await copyFile(sessionPath, sessionOut);
  }

  if (await exists(correctionsPath)) {
    let correctionsRaw = await readFile(correctionsPath, 'utf8');
    const privacy = await loadPrivacyControls(baseDir);
    if (correctionsRaw.trim().length > 0) {
      const lines = correctionsRaw.split('\n').map(s => s.trim()).filter(Boolean);
      const filtered = lines.map(line => applyPrivacyToCorrection(JSON.parse(line), privacy));
      correctionsRaw = `${filtered.map(item => JSON.stringify(item)).join('\n')}\n`;
    }

    if (process.env.TEAM_S3_CORRECTIONS_PUT_URL) {
      await fetch(process.env.TEAM_S3_CORRECTIONS_PUT_URL, { method: 'PUT', body: correctionsRaw });
    }
    await writeFile(correctionsOut, correctionsRaw, 'utf8');
  }

  return { sessionOut, correctionsOut };
}

export async function downloadTeamContext(baseDir = process.cwd()) {
  const stateDir = getStateDir(baseDir);
  const teamDir = getTeamSyncDir(baseDir);
  await mkdir(stateDir, { recursive: true });
  await mkdir(teamDir, { recursive: true });

  const localSessionPath = join(stateDir, 'session.json');
  const localCorrectionsPath = join(stateDir, 'training-data.jsonl');

  // S3 session pull (optional)
  if (process.env.TEAM_S3_SESSION_GET_URL) {
    const response = await fetch(process.env.TEAM_S3_SESSION_GET_URL);
    if (response.ok) {
      const text = await response.text();
      await writeFile(localSessionPath, text, 'utf8');
    }
  }

  // S3 corrections pull (optional)
  if (process.env.TEAM_S3_CORRECTIONS_GET_URL) {
    const response = await fetch(process.env.TEAM_S3_CORRECTIONS_GET_URL);
    if (response.ok) {
      const text = await response.text();
      await writeFile(localCorrectionsPath, text, 'utf8');
    }
  }

  // Local shared folder sync fallback/merge.
  const files = await readdir(teamDir);
  const sessionCandidates = files.filter(name => name.endsWith('-session.json'));
  const correctionCandidates = files.filter(name => name.endsWith('-training-data.jsonl'));

  if (sessionCandidates.length > 0 && !(await exists(localSessionPath))) {
    const src = join(teamDir, sessionCandidates.sort().at(-1) as string);
    await copyFile(src, localSessionPath);
  }

  let mergedCorrections = '';
  const seen = new Set<string>();

  if (await exists(localCorrectionsPath)) {
    const local = await readFile(localCorrectionsPath, 'utf8');
    for (const line of local.split('\n').map(s => s.trim()).filter(Boolean)) {
      seen.add(line);
      mergedCorrections += `${line}\n`;
    }
  }

  for (const file of correctionCandidates) {
    const raw = await readFile(join(teamDir, file), 'utf8');
    for (const line of raw.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (!seen.has(line)) {
        seen.add(line);
        mergedCorrections += `${line}\n`;
      }
    }
  }

  if (mergedCorrections.length > 0) {
    await writeFile(localCorrectionsPath, mergedCorrections, 'utf8');
  }

  return {
    sessionPath: localSessionPath,
    correctionsPath: localCorrectionsPath,
    mergedCount: seen.size
  };
}

export async function getTeamSyncStatus(baseDir = process.cwd()) {
  const teamDir = getTeamSyncDir(baseDir);
  await mkdir(teamDir, { recursive: true });
  const files = await readdir(teamDir);
  const privacy = await loadPrivacyControls(baseDir);
  return {
    teamDir,
    files,
    privacy
  };
}

export { applyPrivacyToCorrection };
