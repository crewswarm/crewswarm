#!/usr/bin/env node
/**
 * SWARM ORCHESTRATOR - Direct RT Channel Communication
 * 
 * Bypasses gateway-bridge.mjs and talks DIRECTLY to RT channels.
 * This avoids the empty response bug in gateway-bridge.
 * 
 * Two-Agent Pattern:
 * 1. PM Agent → Plans naturally with reasoning
 * 2. Parser (same PM) → Converts plan → JSON
 * 3. Worker Agents → Execute tasks
 * 4. Verification → Check actual results
 * 
 * Version: 2.0.0
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/Users/jeffhobbs/Desktop/OpenClaw';
const RT_BASE = join(process.env.HOME, '.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt');
const COMMAND_CHANNEL = join(RT_BASE, 'channels/command.jsonl');
const DONE_CHANNEL = join(RT_BASE, 'channels/done.jsonl');
const LOG_DIR = join(OPENCLAW_DIR, 'orchestrator-logs');
const DISPATCH_LOG = join(LOG_DIR, 'swarm-dispatch.jsonl');

// Ensure dirs exist
for (const dir of [RT_BASE, join(RT_BASE, 'channels'), LOG_DIR]) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

//=============================================================================
// DIRECT RT CHANNEL COMMUNICATION
//=============================================================================

/**
 * Send command to RT agent via command.jsonl
 */
async function sendCommand(agentId, task, correlationId) {
  const command = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    sender_agent_id: 'orchestrator',
    sender_type: 'external',
    channel: 'command',
    from: 'orchestrator',
    to: agentId,
    type: 'command.run_task',
    payload: {
      source: 'orchestrator',
      prompt: task,  // RT daemon expects 'prompt' not 'task'
      message: task,  // Fallback
      idempotencyKey: correlationId,
    },
    priority: 'high',
    correlationId,
  };
  
  await appendFile(COMMAND_CHANNEL, JSON.stringify(command) + '\n');
  console.error(`📤 ${agentId} ${task.substring(0, 80)}${task.length > 80 ? '...' : ''}`);
}

/**
 * Wait for reply from agent via done.jsonl
 */
async function waitForReply(agentId, correlationId, timeoutMs = 60000) {
  const startTime = Date.now();
  const startPos = existsSync(DONE_CHANNEL) ? statSync(DONE_CHANNEL).size : 0;
  
  console.error(`⏳ Waiting for ${agentId} reply...`);
  
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 500)); // Poll every 500ms
    
    if (!existsSync(DONE_CHANNEL)) continue;
    
    const content = readFileSync(DONE_CHANNEL, 'utf8');
    const newContent = content.substring(startPos);
    const lines = newContent.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        
        // Match by correlation ID or agent ID + recent timestamp
        const isMatch = 
          msg.correlationId === correlationId ||
          (msg.from === agentId && new Date(msg.ts).getTime() > startTime - 2000);
        
        if (isMatch && msg.payload?.reply) {
          console.error(`✅ Reply received from ${agentId}`);
          return msg.payload.reply;
        }
      } catch (err) {
        // Skip invalid JSON lines
      }
    }
  }
  
  throw new Error(`Timeout waiting for ${agentId} (${timeoutMs}ms)`);
}

/**
 * Call an RT agent
 */
async function callAgent(agentId, prompt) {
  const correlationId = randomUUID();
  await sendCommand(agentId, prompt, correlationId);
  const reply = await waitForReply(agentId, correlationId);
  return reply;
}

//=============================================================================
// TWO-AGENT ORCHESTRATION PATTERN
//=============================================================================

async function askPMForPlan(requirement) {
  console.log('\n📋 Step 1: PM creates natural language plan...\n');
  
  const prompt = `You are the PM agent for OpenClaw swarm.

Requirement: "${requirement}"

Create a plan to accomplish this. Think through:
- What needs to be built/fixed/tested?
- Which agents should work on it?
- What order should tasks happen in?

Available agents:
- opencode-coder: Implements features, writes code
- opencode-qa: Writes tests, validates functionality
- opencode-fixer: Debugs issues, fixes bugs
- security: Security audits, vulnerability checks

Explain your plan naturally. Examples:
- "I'll have opencode-coder create the login endpoint, then opencode-qa will write integration tests."
- "opencode-fixer should debug the timeout, then security audits the auth flow."

Be specific about what each agent should do.`;

  return await callAgent('opencode-pm', prompt);
}

async function parseIntoJSON(naturalPlan, requirement) {
  console.log('\n📊 Step 2: PM converts plan to structured JSON...\n');
  
  const opId = randomUUID().split('-')[0];
  const prompt = `You are a plan parser. Convert this natural language plan into dispatch JSON.

ORIGINAL REQUIREMENT:
"${requirement}"

PM'S NATURAL LANGUAGE PLAN:
${naturalPlan}

Output ONLY valid JSON in this EXACT format (no markdown, no explanation):
{
  "op_id": "op-${opId}",
  "summary": "Brief summary",
  "dispatch": [
    {"agent": "opencode-coder", "task": "Specific task", "acceptance": "Success criteria"}
  ]
}

Rules:
- agent must be: opencode-coder, opencode-qa, opencode-fixer, or security
- task must be clear and actionable
- Output ONLY the JSON, nothing else

JSON:`;

  const response = await callAgent('opencode-pm', prompt);
  
  // Extract JSON
  let jsonText = response.trim()
    .replace(/^```(?:json)?\s*/gm, '')
    .replace(/```\s*$/gm, '');
  
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Fallback: create simple plan
    console.log('⚠️  Could not parse JSON, creating default plan');
    return {
      op_id: `op-${opId}`,
      summary: requirement.substring(0, 100),
      dispatch: [{
        agent: 'opencode-coder',
        task: requirement,
        acceptance: 'Task completed'
      }]
    };
  }
  
  const plan = JSON.parse(jsonMatch[0]);
  
  // Validate
  if (!plan.dispatch || !Array.isArray(plan.dispatch) || plan.dispatch.length === 0) {
    plan.dispatch = [{
      agent: 'opencode-coder',
      task: requirement,
      acceptance: 'Task completed'
    }];
  }
  
  return plan;
}

async function executeTasks(plan) {
  console.log(`\n🚀 Step 3: Executing ${plan.dispatch.length} task(s)...\n`);
  
  const results = [];
  
  for (const [i, task] of plan.dispatch.entries()) {
    console.log(`\n[${i + 1}/${plan.dispatch.length}]`);
    
    const startTime = Date.now();
    
    try {
      const output = await callAgent(task.agent, task.task);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      console.error(`✅ Completed in ${duration}s\n`);
      
      results.push({
        success: true,
        agent: task.agent,
        task: task.task,
        output,
        duration
      });
      
      await logDispatch({
        ts: new Date().toISOString(),
        op_id: plan.op_id,
        task_num: i + 1,
        agent: task.agent,
        status: 'completed',
        duration_s: parseFloat(duration)
      });
      
    } catch (err) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`❌ Failed in ${duration}s: ${err.message}\n`);
      
      results.push({
        success: false,
        agent: task.agent,
        task: task.task,
        error: err.message,
        duration
      });
      
      await logDispatch({
        ts: new Date().toISOString(),
        op_id: plan.op_id,
        task_num: i + 1,
        agent: task.agent,
        status: 'failed',
        error: err.message,
        duration_s: parseFloat(duration)
      });
    }
  }
  
  return results;
}

async function verifyResults(plan, results) {
  console.log('\n🔍 Step 4: Verifying results...\n');
  
  const verifications = [];
  
  for (const [i, task] of plan.dispatch.entries()) {
    const result = results[i];
    
    if (!result.success) {
      console.log(`   ❌ Task ${i + 1}: Failed during execution`);
      verifications.push({ task_num: i + 1, verified: false });
      continue;
    }
    
    // Extract file paths
    const filePaths = extractFilePaths(task.task);
    
    if (filePaths.length === 0) {
      console.log(`   ✅ Task ${i + 1}: No files to verify`);
      verifications.push({ task_num: i + 1, verified: true });
      continue;
    }
    
    // Check files exist
    const missing = [];
    const found = [];
    
    for (const filepath of filePaths) {
      if (existsSync(filepath)) {
        const size = statSync(filepath).size;
        found.push({ path: filepath, size });
        console.log(`   ✅ ${filepath} (${size} bytes)`);
      } else {
        missing.push(filepath);
        console.log(`   ❌ ${filepath} (missing)`);
      }
    }
    
    verifications.push({
      task_num: i + 1,
      verified: missing.length === 0,
      found,
      missing
    });
  }
  
  return verifications;
}

//=============================================================================
// UTILITIES
//=============================================================================

function extractFilePaths(text) {
  const paths = new Set();
  
  // /path/to/file.ext
  const unix = text.match(/\/[\w\-./]+\.\w+/g);
  if (unix) unix.forEach(p => paths.add(p));
  
  // ~/path
  const home = text.match(/~\/[\w\-./]+/g);
  if (home) {
    home.forEach(p => paths.add(p.replace('~', process.env.HOME)));
  }
  
  // Quoted paths
  const quoted = text.match(/["'`](\/[\w\-./]+)["'`]/g);
  if (quoted) {
    quoted.forEach(p => paths.add(p.replace(/["'`]/g, '')));
  }
  
  return Array.from(paths);
}

async function logDispatch(entry) {
  try {
    await appendFile(DISPATCH_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Silent fail
  }
}

//=============================================================================
// MAIN
//=============================================================================

async function orchestrate(requirement) {
  const startTime = Date.now();
  const opId = `op-${randomUUID().split('-')[0]}`;
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🎯 SWARM ORCHESTRATOR v2.0 (Direct RT Channels)`);
  console.log(`   Operation: ${opId}`);
  console.log(`   Requirement: ${requirement}`);
  console.log(`${'═'.repeat(70)}`);
  
  try {
    // Step 1: Natural plan
    const naturalPlan = await askPMForPlan(requirement);
    console.log(`\n📝 PM's Plan:\n${naturalPlan.substring(0, 500)}${naturalPlan.length > 500 ? '...' : ''}\n`);
    
    // Step 2: Parse to JSON
    const plan = await parseIntoJSON(naturalPlan, requirement);
    plan.op_id = opId;
    
    console.log(`\n✅ Structured Plan:`);
    plan.dispatch.forEach((t, i) => {
      console.log(`   ${i + 1}. ${t.agent}: ${t.task.substring(0, 60)}${t.task.length > 60 ? '...' : ''}`);
    });
    
    // Step 3: Execute
    const results = await executeTasks(plan);
    
    // Step 4: Verify
    const verifications = await verifyResults(plan, results);
    
    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const verified = verifications.filter(v => v.verified).length;
    
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 COMPLETE: ${opId} (${duration}s)`);
    console.log(`   ✅ Succeeded: ${succeeded}/${results.length}`);
    console.log(`   ❌ Failed: ${failed}/${results.length}`);
    console.log(`   🔍 Verified: ${verified}/${verifications.length}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    if (failed > 0 || verified < verifications.length) {
      console.log('⚠️  Some tasks failed or could not be verified.\n');
      process.exit(1);
    }
    
    console.log('🎉 All tasks completed and verified!\n');
    process.exit(0);
    
  } catch (error) {
    console.error(`\n❌ ORCHESTRATION FAILED: ${error.message}\n`);
    if (process.env.DEBUG) console.error(error);
    process.exit(1);
  }
}

//=============================================================================
// CLI
//=============================================================================

const requirement = process.argv.slice(2).join(' ');

if (!requirement) {
  console.log(`
🎯 Swarm Orchestrator v2.0

Usage:
  node swarm-orchestrator.mjs "<requirement>"

Examples:
  node swarm-orchestrator.mjs "Create /tmp/test.txt with 'hello'"
  node swarm-orchestrator.mjs "Build user auth with JWT + tests"

Features:
  • Direct RT channel communication (bypasses gateway-bridge bugs)
  • Two-agent pattern: PM plans → PM parses → Workers execute
  • File verification (checks artifacts actually exist)
  • Full execution logs

Logs: ${DISPATCH_LOG}
`);
  process.exit(1);
}

orchestrate(requirement);

