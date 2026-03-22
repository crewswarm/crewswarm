#!/usr/bin/env node
/**
 * Test runner that loads API keys from ~/.crewswarm/crewswarm.json
 * Then runs the direct LLM tests
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const configPath = path.join(homedir(), '.crewswarm/crewswarm.json');

console.log('Loading API keys from ~/.crewswarm/crewswarm.json...\n');

if (!fs.existsSync(configPath)) {
  console.error('❌ No crewswarm.json found at', configPath);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Map providers to env vars
const envMap = {
  xai: 'XAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  opencode: 'OPENCODE_API_KEY'
};

const env = { ...process.env };
let loaded = 0;

Object.entries(envMap).forEach(([provider, envVar]) => {
  const apiKey = config.providers?.[provider]?.apiKey;
  if (apiKey && apiKey.length > 5) {
    env[envVar] = apiKey;
    console.log(`✓ Loaded ${envVar} from ${provider}`);
    loaded++;
  } else {
    console.log(`⊘ ${envVar} not configured in ${provider}`);
  }
});

console.log(`\n${loaded} API keys loaded\n`);

if (loaded === 0) {
  console.error('❌ No API keys configured');
  process.exit(1);
}

// Run the test script with loaded env
console.log('Running benchmark suite...\n');
execSync('node scripts/test-direct-llm.mjs', {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
});
