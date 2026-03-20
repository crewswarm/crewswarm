#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const args = process.argv.slice(2);

// Load .env from crew-cli root (needed when spawned by studio or other processes)
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// Load API keys from ~/.crewswarm/crewswarm.json providers (only if not already set)
const swarmCfgPath = join(homedir(), '.crewswarm', 'crewswarm.json');
if (existsSync(swarmCfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(swarmCfgPath, 'utf8'));
    const providers = cfg?.providers || {};
    const keyMap = {
      groq: 'GROQ_API_KEY',
      xai: 'XAI_API_KEY',
      google: 'GOOGLE_API_KEY',
      gemini: 'GEMINI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      openai: 'OPENAI_API_KEY',
      mistral: 'MISTRAL_API_KEY',
    };
    for (const [provider, envVar] of Object.entries(keyMap)) {
      const key = providers[provider]?.apiKey;
      if (key && !process.env[envVar]) process.env[envVar] = key;
    }
    // Also load env block (CREW_CHAT_MODEL, CREW_EXECUTION_MODEL, etc.)
    const envBlock = cfg?.env || {};
    for (const [k, v] of Object.entries(envBlock)) {
      if (v != null && v !== '' && !process.env[k]) process.env[k] = String(v);
    }
  } catch {
    // Non-fatal: config may be malformed or missing
  }
}

// Fast path for --version/-V so lightweight checks do not slow/flake CLI version output.
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  console.log(pkg.version || '0.0.0');
  process.exit(0);
}

// Fast path for top-level help used by smoke/integration checks.
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(`Usage: crew [options] [command]

Commands:
  chat            Chat with CrewSwarm (routed to best agent)
  auto            Autonomous mode (iterate until done)
  exec            Execute a task directly
  repl            Interactive REPL session
  diff            Show colored git diff
  validate        Blind AI code review
  test-first      TDD: tests -> implement -> validate
  plan            Plan a task
  doctor          Health check

Options:
  -h, --help     display help for command
  -V, --version  output the version number`);
  process.exit(0);
}

try {
  const { main } = await import('../dist/crew.mjs');
  await main(args);
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
