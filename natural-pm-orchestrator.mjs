#!/usr/bin/env node
/**
 * NATURAL LANGUAGE PM
 * 
 * PM replies in natural language ("I'll have Codex create the file, then QA test it")
 * This script parses that into structured JSON for dispatch.
 * 
 * More reliable because models are GREAT at natural language, TERRIBLE at forced JSON output.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/Users/jeffhobbs/Desktop/OpenClaw';
const GATEWAY_BRIDGE_PATH = `${OPENCLAW_DIR}/gateway-bridge.mjs`;

// Parser rules: extract task dispatch from natural language
function parseNaturalLanguagePlan(text) {
  const dispatch = [];
  
  // Pattern 1: "I'll have X do Y"
  const havePattern = /I'?ll have (\w+[-\w]*) (.*?)(?:\.|Then|,|$)/gi;
  let match;
  while ((match = havePattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase();
    const task = match[2].trim();
    if (agent && task) {
      dispatch.push({
        agent: normalizeAgentName(agent),
        task,
        acceptance: `Task completed successfully`
      });
    }
  }
  
  // Pattern 2: "Codex will/should create X"
  const willPattern = /(\w+[-\w]*) (?:will|should|can) (create|implement|write|fix|test|audit|debug) (.*?)(?:\.|Then|,|$)/gi;
  while ((match = willPattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase();
    const action = match[2];
    const target = match[3].trim();
    if (agent && action && target) {
      dispatch.push({
        agent: normalizeAgentName(agent),
        task: `${action.charAt(0).toUpperCase() + action.slice(1)} ${target}`,
        acceptance: `${target} ${action}d successfully`
      });
    }
  }
  
  // Pattern 3: "Task for X: Y"
  const taskForPattern = /Task for (\w+[-\w]*): (.*?)(?:\n|$)/gi;
  while ((match = taskForPattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase();
    const task = match[2].trim();
    if (agent && task) {
      dispatch.push({
        agent: normalizeAgentName(agent),
        task,
        acceptance: `Task completed`
      });
    }
  }
  
  return dispatch;
}

function normalizeAgentName(name) {
  const map = {
    'codex': 'crew-coder',
    'coder': 'crew-coder',
    'developer': 'crew-coder',
    'qa': 'crew-qa',
    'tester': 'crew-qa',
    'test': 'crew-qa',
    'fixer': 'crew-fixer',
    'debugger': 'crew-fixer',
    'security': 'security',
    'guardian': 'security',
    'audit': 'security',
    'pm': 'crew-pm',
    'planner': 'crew-pm',
    'quill': 'crew-main',
    'main': 'crew-main',
  };
  return map[name] || name;
}

async function askPM(requirement) {
  return new Promise((resolve, reject) => {
    // Ask PM in NATURAL LANGUAGE, not forced JSON
    const naturalPrompt = `Analyze this requirement and break it down:

"${requirement}"

Tell me which agents should work on this. Available agents:
- Codex (crew-coder): implements code
- Tester (crew-qa): writes tests
- Fixer (crew-fixer): debugs issues
- Security (security): audits for vulnerabilities

Explain your plan naturally. For example:
"I'll have Codex create the file, then Tester will write tests for it."`;

    const proc = spawn('node', [GATEWAY_BRIDGE_PATH, naturalPrompt], {
      cwd: OPENCLAW_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCREW_RT_AGENT: 'crew-pm',
      },
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PM failed (code ${code}): ${stderr}`));
        return;
      }
      resolve(stdout);
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn PM: ${err.message}`));
    });
  });
}

/**
 * Dispatch to a specific agent only (no broadcast, no race).
 * Tries --send first (RT targeted); on RT auth error falls back to legacy spawn.
 */
async function dispatchTask(agent, task) {
  console.log(`\n📤 Dispatching to ${agent} only:`);
  console.log(`   ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`);
  
  const runSend = () => new Promise((resolve, reject) => {
    const proc = spawn('node', [GATEWAY_BRIDGE_PATH, '--send', agent, task], {
      cwd: OPENCLAW_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => (code === 0 ? resolve(stdout.trim() || '(no output)') : reject(new Error(stderr || stdout))));
    proc.on('error', reject);
  });

  const runLegacy = () => new Promise((resolve, reject) => {
    const proc = spawn('node', [GATEWAY_BRIDGE_PATH, task], {
      cwd: OPENCLAW_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCREW_RT_AGENT: agent },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`   ✅ ${agent} completed`);
        resolve(stdout.trim() || '(no output)');
      } else {
        reject(new Error(stderr || stdout || `${agent} failed`));
      }
    });
    proc.on('error', reject);
  });

  try {
    const out = await runSend();
    console.log(`   ✅ ${agent} completed`);
    return out;
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('realtime token') || msg.includes('realtime error')) {
      process.stderr.write(`   ⚠️  RT send failed (token?), using legacy spawn for ${agent}\n`);
      return runLegacy();
    }
    console.log(`   ❌ ${agent} failed`);
    throw err;
  }
}

async function main() {
  const requirement = process.argv[2];
  if (!requirement) {
    console.error('Usage: node natural-pm-orchestrator.mjs "<requirement>"');
    process.exit(1);
  }
  
  console.log('🚀 Natural Language PM Orchestrator\n');
  console.log('📋 Asking PM for plan...\n');
  
  try {
    const pmReply = await askPM(requirement);
    
    console.log('\n📊 Parsing PM\'s plan...\n');
    const dispatch = parseNaturalLanguagePlan(pmReply);
    
    if (dispatch.length === 0) {
      console.log('⚠️  PM didn\'t assign any tasks. Falling back to direct execution.');
      dispatch.push({
        agent: 'crew-coder',
        task: requirement,
        acceptance: 'Task completed'
      });
    }
    
    console.log(`✅ Plan: ${dispatch.length} task(s)\n`);
    for (const [i, task] of dispatch.entries()) {
      console.log(`${i + 1}. ${task.agent}: ${task.task.substring(0, 80)}`);
    }
    
    console.log('\n🚀 Executing tasks...\n');
    
    for (const task of dispatch) {
      await dispatchTask(task.agent, task.task);
    }
    
    console.log('\n✅ All tasks completed!');
    
  } catch (error) {
    console.error(`\n❌ Orchestration failed: ${error.message}`);
    process.exit(1);
  }
}

main();

