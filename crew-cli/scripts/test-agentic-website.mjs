#!/usr/bin/env node
/**
 * Test agentic loop with a website task.
 * Loads API keys from ~/.crewswarm/crewswarm.json
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const configPath = join(homedir(), '.crewswarm', 'crewswarm.json');
if (!existsSync(configPath)) {
  console.error('❌ No crewswarm.json at', configPath);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const env = { ...process.env };

for (const [provider, envVar] of [
  ['xai', 'XAI_API_KEY'],
  ['google', 'GEMINI_API_KEY'],
  ['gemini', 'GEMINI_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['groq', 'GROQ_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY']
]) {
  const key = config.providers?.[provider]?.apiKey;
  if (key && key.length > 5 && !env[envVar]) {
    env[envVar] = key;
    console.log(`✓ Loaded ${envVar} from ${provider}`);
  }
}

if (!env.XAI_API_KEY && !env.GEMINI_API_KEY && !env.OPENAI_API_KEY && !env.DEEPSEEK_API_KEY && !env.GROQ_API_KEY && !env.ANTHROPIC_API_KEY && !env.OPENROUTER_API_KEY) {
  console.error('❌ No API keys in crewswarm.json (need xai/google/openai/deepseek/groq/anthropic/openrouter)');
  process.exit(1);
}

const task = 'Create a simple personal portfolio website: index.html with a hero section, about section, and contact form. Use plain HTML and CSS, no frameworks. Make it look clean and modern.';
const projectDir = '/tmp/crew-agentic-test';
const crewPath = join(process.cwd(), 'bin', 'crew.js');

console.log('\nRunning agentic test...');
console.log('Task:', task.slice(0, 80) + '...');
console.log('Project:', projectDir);
console.log('');

execSync(`mkdir -p "${projectDir}" && cd "${projectDir}" && node "${crewPath}" chat "${task}" --json`, {
  env: { ...env, CREW_VERBOSE: 'true' },
  stdio: 'inherit',
  timeout: 180000
});
