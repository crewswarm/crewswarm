#!/usr/bin/env node
/**
 * Apply role-optimized models to all agents
 * 
 * Based on Cursor's research: "Different models excel at different roles."
 * See docs/MODEL-ROLE-OPTIMIZATION.md for details.
 * 
 * Usage:
 *   node scripts/apply-role-optimized-models.mjs           # Best value (DeepSeek + Groq)
 *   node scripts/apply-role-optimized-models.mjs --free    # All free tier
 *   node scripts/apply-role-optimized-models.mjs --quality # Best quality (paid)
 *   node scripts/apply-role-optimized-models.mjs --dry-run # Preview only
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = join(homedir(), '.crewswarm', 'crewswarm.json');
const DRY_RUN = process.argv.includes('--dry-run');
const MODE = process.argv.includes('--free') ? 'free'
  : process.argv.includes('--quality') ? 'quality'
  : 'value'; // default

// Role-optimized model assignments
const MODEL_PRESETS = {
  value: {
    // Best value: mix of DeepSeek + Groq free tier
    'crew-pm': 'groq/llama-3.3-70b-versatile',
    'orchestrator': 'groq/llama-3.3-70b-versatile',
    'crew-judge': 'groq/llama-3.3-70b-versatile',
    'crew-coder': 'deepseek/deepseek-chat',
    'crew-coder-front': 'deepseek/deepseek-chat',
    'crew-coder-back': 'deepseek/deepseek-chat',
    'crew-fixer': 'deepseek/deepseek-reasoner',
    'crew-qa': 'deepseek/deepseek-reasoner',
    'crew-security': 'deepseek/deepseek-reasoner',
    'crew-main': 'deepseek/deepseek-chat',
    'crew-lead': 'deepseek/deepseek-chat',
    'crew-frontend': 'deepseek/deepseek-chat',
    'crew-copywriter': 'groq/llama-3.3-70b-versatile',
    'crew-researcher': 'perplexity/sonar-pro',
    'crew-architect': 'deepseek/deepseek-reasoner',
    'crew-seo': 'groq/llama-3.3-70b-versatile',
    'crew-ml': 'deepseek/deepseek-reasoner',
    'crew-github': 'groq/llama-3.3-70b-versatile',
  },
  free: {
    // All free tier
    'crew-pm': 'groq/llama-3.3-70b-versatile',
    'orchestrator': 'groq/llama-3.3-70b-versatile',
    'crew-judge': 'groq/llama-3.3-70b-versatile',
    'crew-coder': 'google/gemini-2.0-flash',
    'crew-coder-front': 'google/gemini-2.0-flash',
    'crew-coder-back': 'google/gemini-2.0-flash',
    'crew-fixer': 'google/gemini-2.0-flash',
    'crew-qa': 'groq/llama-3.3-70b-versatile',
    'crew-security': 'groq/llama-3.3-70b-versatile',
    'crew-main': 'groq/llama-3.3-70b-versatile',
    'crew-lead': 'groq/llama-3.3-70b-versatile',
    'crew-frontend': 'google/gemini-2.0-flash',
    'crew-copywriter': 'groq/llama-3.3-70b-versatile',
    'crew-researcher': 'groq/llama-3.3-70b-versatile',
    'crew-architect': 'groq/llama-3.3-70b-versatile',
    'crew-seo': 'groq/llama-3.3-70b-versatile',
    'crew-ml': 'google/gemini-2.0-flash',
    'crew-github': 'groq/llama-3.3-70b-versatile',
  },
  quality: {
    // Best quality (paid)
    'crew-pm': 'cerebras/llama-3.3-70b',
    'orchestrator': 'cerebras/llama-3.3-70b',
    'crew-judge': 'groq/llama-3.3-70b-versatile',
    'crew-coder': 'anthropic/claude-sonnet-4-20250514',
    'crew-coder-front': 'anthropic/claude-sonnet-4-20250514',
    'crew-coder-back': 'anthropic/claude-sonnet-4-20250514',
    'crew-fixer': 'anthropic/claude-sonnet-4-20250514',
    'crew-qa': 'deepseek/deepseek-reasoner',
    'crew-security': 'anthropic/claude-sonnet-4-20250514',
    'crew-main': 'anthropic/claude-sonnet-4-20250514',
    'crew-lead': 'openai/gpt-4.1',
    'crew-frontend': 'anthropic/claude-sonnet-4-20250514',
    'crew-copywriter': 'anthropic/claude-haiku-4-5',
    'crew-researcher': 'perplexity/sonar-pro',
    'crew-architect': 'deepseek/deepseek-reasoner',
    'crew-seo': 'anthropic/claude-haiku-4-5',
    'crew-ml': 'deepseek/deepseek-reasoner',
    'crew-github': 'groq/llama-3.3-70b-versatile',
  }
};

const preset = MODEL_PRESETS[MODE];

async function applyOptimizedModels() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('❌ Config not found:', CONFIG_PATH);
    process.exit(1);
  }

  const raw = await readFile(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);

  if (!Array.isArray(config.agents)) {
    console.error('❌ No agents array in config');
    process.exit(1);
  }

  console.log(`🎯 Applying role-optimized models (mode: ${MODE})`);
  console.log('');

  const changes = [];

  for (const agent of config.agents) {
    const agentId = agent.id;
    const newModel = preset[agentId];

    if (!newModel) {
      // Not in optimization list, skip
      continue;
    }

    const oldModel = agent.model || '(none)';
    
    if (oldModel !== newModel) {
      changes.push({
        agent: agentId,
        from: oldModel,
        to: newModel
      });
      
      if (!DRY_RUN) {
        agent.model = newModel;
      }
    }
  }

  if (changes.length === 0) {
    console.log('✅ All agents already using optimized models');
    return;
  }

  console.log(`📝 ${changes.length} model assignments to update:\n`);
  
  for (const { agent, from, to } of changes) {
    const role = getAgentRole(agent);
    console.log(`   ${agent.padEnd(20)} ${role.padEnd(12)} ${from.padEnd(30)} → ${to}`);
  }

  if (DRY_RUN) {
    console.log('\n💡 Dry run — no changes written. Remove --dry-run to apply.');
    return;
  }

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n✅ Updated ${changes.length} agents in ${CONFIG_PATH}`);
  console.log('\n📌 Next steps:');
  console.log('   1. Restart agent bridges: npm run restart-crew');
  console.log('   2. View recommendations: cat docs/MODEL-ROLE-OPTIMIZATION.md');
}

function getAgentRole(agentId) {
  if (['crew-pm', 'orchestrator'].includes(agentId)) return 'PLANNER';
  if (agentId === 'crew-judge') return 'JUDGE';
  if (['crew-coder', 'crew-coder-front', 'crew-coder-back', 'crew-frontend', 'crew-fixer'].includes(agentId)) return 'WORKER';
  if (['crew-qa', 'crew-security'].includes(agentId)) return 'ANALYST';
  if (['crew-main', 'crew-lead'].includes(agentId)) return 'COORDINATOR';
  return 'OTHER';
}

applyOptimizedModels().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
