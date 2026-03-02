#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CFG_PATH = path.join(os.homedir(), '.crewswarm', 'crewswarm.json');

console.log(`Validating ${CFG_PATH}...`);

try {
  const raw = fs.readFileSync(CFG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  
  console.log('✓ Valid JSON');
  
  // Check structure
  const errors = [];
  if (!cfg.agents || !Array.isArray(cfg.agents)) errors.push('Missing or invalid agents array');
  if (!cfg.providers || typeof cfg.providers !== 'object') errors.push('Missing or invalid providers object');
  
  if (errors.length > 0) {
    console.log('✗ Structure errors:');
    errors.forEach(e => console.log(`  - ${e}`));
    process.exit(1);
  }
  
  console.log(`✓ Structure OK: ${cfg.agents.length} agents, ${Object.keys(cfg.providers).length} providers`);
  
  // Check for duplicates
  const agentIds = cfg.agents.map(a => a.id);
  const dupAgents = agentIds.filter((id, i) => agentIds.indexOf(id) !== i);
  if (dupAgents.length > 0) {
    console.log(`✗ Duplicate agent IDs: ${dupAgents.join(', ')}`);
    process.exit(1);
  }
  
  const providerIds = Object.keys(cfg.providers);
  const dupProviders = providerIds.filter((id, i) => providerIds.indexOf(id) !== i);
  if (dupProviders.length > 0) {
    console.log(`✗ Duplicate provider IDs: ${dupProviders.join(', ')}`);
    process.exit(1);
  }
  
  console.log('✓ No duplicates');
  
  // List search tools
  const searchTools = ['parallel', 'brave', 'greptile'];
  const toolsInProviders = searchTools.filter(t => cfg.providers[t]);
  const toolsInEnv = searchTools.filter(t => cfg.env?.[`${t.toUpperCase()}_API_KEY`]);
  
  console.log(`\nSearch tools:`);
  searchTools.forEach(t => {
    const inProv = toolsInProviders.includes(t);
    const inEnv = toolsInEnv.includes(t);
    console.log(`  ${t}: providers=${inProv ? '✓' : '✗'}, env=${inEnv ? '✓' : '✗'}`);
  });
  
  console.log('\n✅ Config valid');
  process.exit(0);
  
} catch (err) {
  console.error('✗ Error:', err.message);
  process.exit(1);
}
