#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const gateway = process.env.QA_GATEWAY || 'http://127.0.0.1:5010';
const timeoutMs = Number.parseInt(process.env.QA_TIMEOUT_MS || '60000', 10);
const requireGateway = String(process.env.QA_REQUIRE_GATEWAY || 'false').toLowerCase() === 'true';

function isRateLimited(text) {
  const s = String(text || '').toLowerCase();
  return s.includes('429') || s.includes('rate limit') || s.includes('too many requests');
}

async function readAuthToken() {
  const token = process.env.CREWSWARM_RT_TOKEN;
  if (token) return token;
  const cfg = join(homedir(), '.crewswarm', 'config.json');
  if (!existsSync(cfg)) return null;
  try {
    const parsed = JSON.parse(await readFile(cfg, 'utf8'));
    return parsed?.rt?.authToken || null;
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, text, data };
}

async function pollStatus(taskId, headers) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { response, text, data } = await fetchJson(`${gateway}/api/status/${taskId}`, {
      method: 'GET',
      headers
    });
    if (!response.ok) {
      throw new Error(`Status API ${response.status}: ${text.slice(0, 300)}`);
    }
    const status = data?.status;
    if (status === 'done') return { kind: 'done', data };
    if (status === 'error') {
      const msg = data?.error || data?.result || 'task failed';
      if (isRateLimited(msg)) return { kind: 'skip_rate_limit', data };
      return { kind: 'error', data };
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return { kind: 'timeout', data: null };
}

async function main() {
  const authToken = await readAuthToken();
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const statusProbe = await fetch(`${gateway}/status`, { headers }).catch(() => null);
  if (!statusProbe || !statusProbe.ok) {
    const msg = `[gateway-contract] gateway not reachable at ${gateway}`;
    if (requireGateway) {
      throw new Error(msg);
    }
    console.log(`${msg} (SKIP)`);
    return;
  }

  const payload = {
    agent: process.env.QA_AGENT || 'crew-main',
    task: 'Reply with exactly: QA_GATEWAY_CONTRACT_OK',
    sessionId: `qa-gateway-${Date.now()}`,
    projectDir: process.cwd(),
    model: process.env.QA_MODEL || undefined,
    engine: process.env.QA_ENGINE || undefined,
    direct: true,
    bypass: false,
    session: {
      id: `qa-gateway-${Date.now()}`,
      source: 'qa-gateway-contract'
    }
  };

  const dispatch = await fetchJson(`${gateway}/api/dispatch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!dispatch.response.ok) {
    if (isRateLimited(dispatch.text)) {
      console.log('[gateway-contract] dispatch rate-limited (SKIP)');
      return;
    }
    throw new Error(`[gateway-contract] dispatch failed ${dispatch.response.status}: ${dispatch.text.slice(0, 400)}`);
  }

  const taskId = dispatch.data?.taskId;
  if (!taskId) {
    throw new Error('[gateway-contract] missing taskId from dispatch response');
  }

  const polled = await pollStatus(taskId, headers);
  if (polled.kind === 'skip_rate_limit') {
    console.log('[gateway-contract] status rate-limited (SKIP)');
    return;
  }
  if (polled.kind === 'timeout') {
    throw new Error(`[gateway-contract] timeout waiting for task ${taskId}`);
  }
  if (polled.kind === 'error') {
    throw new Error(`[gateway-contract] task failed: ${JSON.stringify(polled.data).slice(0, 500)}`);
  }

  console.log(`[gateway-contract] PASS taskId=${taskId}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

