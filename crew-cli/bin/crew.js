#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

import { existsSync } from 'fs';

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
  chat
  plan
  doctor
  repl

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
