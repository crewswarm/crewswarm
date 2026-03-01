#!/usr/bin/env node
/**
 * Test CrewSwarm Dashboard project switching functionality.
 *
 * Prerequisites:
 * - Dashboard running at http://localhost:4319
 * - crew-lead running on :5010
 * - At least one project (e.g. crew-cli) in Projects tab
 *
 * Usage: node scripts/test-project-switching.mjs
 *
 * This script exercises the API directly. For full browser UI verification,
 * manually follow the steps in docs/TEST-PROJECT-SWITCHING.md
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:4319';
const TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.crewswarm', 'config.json'), 'utf8'));
    return cfg?.rt?.authToken || '';
  } catch {
    return '';
  }
})();

const headers = {
  'content-type': 'application/json',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  console.log('🧪 CrewSwarm Project Switching Test\n');

  if (!TOKEN) {
    console.error('❌ No auth token in ~/.crewswarm/config.json (rt.authToken)');
    process.exit(1);
  }

  try {
    // 1. Get projects
    const projectsData = await fetchJSON(`${BASE}/api/projects`);
    const projects = projectsData.projects || [];
    const crewCli = projects.find(
      (p) =>
        p.name?.toLowerCase().includes('crew-cli') ||
        p.name?.toLowerCase().includes('crewswarmcli') ||
        p.id === 'crew-cli'
    );
    const crewCliDir = crewCli?.outputDir;

    console.log('Projects:', projects.map((p) => `${p.name} (${p.outputDir})`).join(', ') || '(none)');
    if (!crewCliDir) {
      console.warn('⚠️ No crew-cli project found — add one in Projects tab. Using first project or repo root.');
    }

    const projectDir1 = crewCliDir || projects[0]?.outputDir || process.cwd();
    const projectDir2 = null; // "Select Project..." = no project, backend uses config/cwd

    // 2. Send "what directory are you in?" with crew-cli project
    console.log('\n1️⃣ Sending with project:', projectDir1 || '(none)');
    const dir1 = await sendPassthroughAndGetDir(projectDir1);
    console.log('   Reported directory:', dir1 || '(no response)');

    // 3. Send same message with no project (root/default)
    console.log('\n2️⃣ Sending with no project (root/default)');
    const dir2 = await sendPassthroughAndGetDir(projectDir2);
    console.log('   Reported directory:', dir2 || '(no response)');

    // 4. Check passthrough-sessions
    const sessionsData = await fetchJSON(`${BASE}/api/passthrough-sessions`);
    const sessions = sessionsData.sessions || {};
    console.log('\n3️⃣ Passthrough sessions:', Object.keys(sessions).length ? Object.keys(sessions) : '(none)');

    // 5. Summary
    console.log('\n--- Summary ---');
    console.log('crew-cli project dir:', dir1);
    console.log('root/default dir:', dir2);
    console.log('sessionId sent: yes (owner)');
    console.log('Session keys:', Object.keys(sessions).join(', ') || '(none)');
    console.log('\n✅ API test complete. For full UI verification:');
    console.log('   - Open http://localhost:4319 → Chat');
    console.log('   - Select project dropdown, engine=gemini');
    console.log('   - Send "what directory are you in?" for each project');
    console.log('   - Check "● Session" indicator appears after first message');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
}

async function sendPassthroughAndGetDir(projectDir) {
  const payload = {
    engine: 'gemini',
    message: 'what directory are you in? Reply with only the absolute path, nothing else.',
    sessionId: 'owner',
  };
  if (projectDir) payload.projectDir = projectDir;

  const r = await fetch(`${BASE}/api/engine-passthrough`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`engine-passthrough failed: ${r.status} ${text.slice(0, 200)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastChunk = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'chunk' && ev.text) lastChunk += ev.text;
      } catch {}
    }
  }

  // Extract directory from response (Gemini may reply with path or extra text)
  const match = lastChunk.match(/\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*/);
  return match ? match[0].trim() : lastChunk.trim().slice(0, 120) || null;
}

main();
