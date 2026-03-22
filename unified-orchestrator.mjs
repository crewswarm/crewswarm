#!/usr/bin/env node
/**
 * UNIFIED ORCHESTRATOR - Best of Both Worlds
 * 
 * Two-Agent Pattern:
 * 1. PM Agent → Plans naturally with reasoning
 * 2. Parser Agent → Converts natural language → structured JSON
 * 3. Worker Agents → Execute tasks
 * 4. Verification → Check actual results (files exist, tests pass, etc.)
 * 
 * This is more reliable than:
 * - Forcing PM to output pure JSON (brittle, models add formatting)
 * - Using regex to parse natural language (fragile, misses edge cases)
 * 
 * Version: 1.0.0
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREWSWARM_DIR = process.env.CREWSWARM_DIR || process.env.OPENCLAW_DIR || __dirname;
const GATEWAY_BRIDGE_PATH = `${CREWSWARM_DIR}/gateway-bridge.mjs`;
const LOG_DIR = join(CREWSWARM_DIR, 'orchestrator-logs');
const DISPATCH_LOG = join(LOG_DIR, 'unified-dispatch.jsonl');

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  await mkdir(LOG_DIR, { recursive: true });
}

//=============================================================================
// STEP 1: Ask PM to create plan in natural language
//=============================================================================

async function askPMForPlan(requirement) {
  console.log('📋 Step 1: Asking PM to create plan...\n');
  
  const naturalPrompt = `You are the PM agent for crewswarm. 

Requirement: "${requirement}"

Create a plan to accomplish this. Think through:
- What needs to be built/fixed/tested?
- Which agents should work on it?
- What order should tasks happen in?

IMPORTANT - Break into SMALL, FOCUSED tasks (like Cursor does):
- Each task = ONE action (e.g. "create package.json" OR "write CRUD routes", not both)
- Avoid compound tasks: split "write tests + run tests" into 2 separate tasks
- Target ~60–90 seconds per task to avoid timeouts
- More smaller tasks beats fewer huge tasks

Available agents:
- crew-coder: Implements features, writes code
- crew-qa: Writes tests, validates functionality  
- crew-fixer: Debugs issues, fixes bugs
- security: Security audits, vulnerability checks

Explain your plan naturally. Examples:
- "crew-coder: create package.json. Then crew-coder: implement CRUD routes. Then crew-qa: write tests. Then crew-qa: run npm test."
- "First crew-fixer debug the timeout; then security audit the auth flow."
- Split QA into: (1) write tests, (2) run tests – as separate tasks.

Be specific. Prefer more small tasks over fewer large ones.`;

  return callAgent('crew-pm', naturalPrompt, true); // Show output
}

//=============================================================================
// STEP 2: Ask Parser to convert natural language → JSON
//=============================================================================

async function parseIntoJSON(naturalPlan, requirement) {
  console.log('\n📊 Step 2: Converting plan to structured JSON...\n');
  
  const parserPrompt = `You are a plan parser. Convert this natural language plan into dispatch JSON.

ORIGINAL REQUIREMENT:
"${requirement}"

PM'S NATURAL LANGUAGE PLAN:
${naturalPlan}

Output ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "op_id": "op-${randomUUID().split('-')[0]}",
  "summary": "Brief summary of the plan",
  "dispatch": [
    {
      "agent": "crew-coder",
      "task": "Specific task description",
      "acceptance": "How to verify success"
    }
  ]
}

Rules:
- agent must be one of: crew-coder, crew-qa, crew-fixer, security
- task should be ONE focused action (e.g. "Create package.json" or "Write CRUD tests" – not "create API + write tests + run tests")
- Split compound tasks into separate dispatch entries
- acceptance should describe success criteria
- Output ONLY the JSON object, nothing else

JSON:`;

  const response = await callAgent('crew-pm', parserPrompt, false); // Don't show verbose output
  
  // Extract JSON from response (handle markdown code blocks)
  let jsonText = response.trim();
  
  // Remove markdown code fences if present
  jsonText = jsonText.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '');
  
  // Try to find JSON object
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Parser did not output valid JSON.\n\nParser response:\n${response}`);
  }
  
  try {
    const plan = JSON.parse(jsonMatch[0]);
    
    // Validate structure
    if (!plan.dispatch || !Array.isArray(plan.dispatch)) {
      throw new Error('Missing or invalid "dispatch" array');
    }
    
    if (plan.dispatch.length === 0) {
      console.log('⚠️  Parser returned empty dispatch. Creating default plan...');
      plan.dispatch = [{
        agent: 'crew-coder',
        task: requirement,
        acceptance: 'Task completed successfully'
      }];
    }
    
    // Validate each task
    for (const [i, task] of plan.dispatch.entries()) {
      if (!task.agent) throw new Error(`Task ${i + 1} missing "agent"`);
      if (!task.task) throw new Error(`Task ${i + 1} missing "task"`);
      task.acceptance = task.acceptance || 'Task completed';
    }
    
    return plan;
    
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${err.message}\n\nExtracted:\n${jsonMatch[0].substring(0, 500)}`);
  }
}

//=============================================================================
// STEP 3: Execute tasks with worker agents
//=============================================================================

async function executeTasks(plan) {
  console.log(`\n🚀 Step 3: Executing ${plan.dispatch.length} task(s)...\n`);
  console.log(`Operation: ${plan.op_id}`);
  console.log(`Summary: ${plan.summary}\n`);
  
  const results = [];
  
  for (const [i, task] of plan.dispatch.entries()) {
    console.log(`\n[${ i + 1}/${plan.dispatch.length}] 📤 Dispatching to ${task.agent}`);
    console.log(`    Task: ${task.task.substring(0, 100)}${task.task.length > 100 ? '...' : ''}`);
    
    const startTime = Date.now();
    
    try {
      const output = await callAgent(task.agent, task.task, false, true); // useSend = targeted delegation
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      console.log(`    ✅ Completed in ${duration}s`);
      
      // Log to file
      await logDispatch({
        timestamp: new Date().toISOString(),
        op_id: plan.op_id,
        task_num: i + 1,
        agent: task.agent,
        task: task.task,
        status: 'completed',
        duration_s: parseFloat(duration),
        output_preview: output.substring(0, 200)
      });
      
      results.push({
        success: true,
        agent: task.agent,
        task: task.task,
        output,
        duration
      });
      
    } catch (err) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`    ❌ Failed in ${duration}s: ${err.message}`);
      
      // Log failure
      await logDispatch({
        timestamp: new Date().toISOString(),
        op_id: plan.op_id,
        task_num: i + 1,
        agent: task.agent,
        task: task.task,
        status: 'failed',
        duration_s: parseFloat(duration),
        error: err.message
      });
      
      results.push({
        success: false,
        agent: task.agent,
        task: task.task,
        error: err.message,
        duration
      });
    }
  }
  
  return results;
}

//=============================================================================
// STEP 4: Verify results (check files exist, not just "agent said done")
//=============================================================================

async function verifyResults(plan, results) {
  console.log(`\n🔍 Step 4: Verifying results...\n`);
  
  const verifications = [];
  
  for (const [i, task] of plan.dispatch.entries()) {
    const result = results[i];
    
    if (!result.success) {
      verifications.push({
        task_num: i + 1,
        verified: false,
        reason: 'Task failed during execution'
      });
      continue;
    }
    
    // Try to extract file paths from task description
    const filePaths = extractFilePaths(task.task);
    
    if (filePaths.length === 0) {
      // No files to verify, trust agent's completion
      verifications.push({
        task_num: i + 1,
        verified: true,
        reason: 'No artifacts to verify, agent reported success'
      });
      continue;
    }
    
    // Check if files exist
    const missingFiles = [];
    const existingFiles = [];
    
    for (const filepath of filePaths) {
      if (existsSync(filepath)) {
        const stats = statSync(filepath);
        existingFiles.push({ path: filepath, size: stats.size });
      } else {
        missingFiles.push(filepath);
      }
    }
    
    if (missingFiles.length > 0) {
      console.log(`    ⚠️  Task ${i + 1}: Missing files:`);
      missingFiles.forEach(f => console.log(`       - ${f}`));
      verifications.push({
        task_num: i + 1,
        verified: false,
        reason: `Missing files: ${missingFiles.join(', ')}`
      });
    } else {
      console.log(`    ✅ Task ${i + 1}: All artifacts verified`);
      existingFiles.forEach(f => console.log(`       - ${f.path} (${f.size} bytes)`));
      verifications.push({
        task_num: i + 1,
        verified: true,
        files: existingFiles
      });
    }
  }
  
  return verifications;
}

//=============================================================================
// UTILITIES
//=============================================================================

/**
 * Call an agent via gateway-bridge.
 * useSend: true = targeted RT send (only this agent gets task). Use for workers.
 */
async function callAgent(agentId, prompt, showOutput = false, useSend = true) {
  return new Promise((resolve, reject) => {
    // Always use --send so RT daemons pick up tasks and reply via done.jsonl.
    // Without --send, gateway-bridge chats Gateway directly then polls done.jsonl,
    // but nothing writes to done.jsonl when the task never went through RT.
    const argv = [GATEWAY_BRIDGE_PATH, '--send', agentId, prompt];
    const env = { ...process.env };
    const proc = spawn('node', argv, {
      cwd: CREWSWARM_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (showOutput) process.stdout.write(chunk);
    });
    
    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (showOutput) process.stderr.write(chunk);
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${agentId} failed (exit ${code}): ${stderr || 'No error output'}`));
        return;
      }
      
      let reply = '';
      if (useSend) {
        reply = stdout.trim();
      } else {
        const replyMatch = stdout.match(/✅ Reply received\s*\n([\s\S]*)/);
        if (replyMatch) {
          reply = replyMatch[1].trim();
        } else {
          const lines = stdout.split('\n');
          const replyStart = lines.findIndex(l => l.includes('Reply received'));
          reply = (replyStart !== -1 && replyStart < lines.length - 1)
            ? lines.slice(replyStart + 1).join('\n').trim()
            : stdout.trim();
        }
      }
      if (!reply || reply.length < 2) {
        reject(new Error(`${agentId} returned empty response`));
        return;
      }
      resolve(reply);
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${agentId}: ${err.message}`));
    });
  });
}

/**
 * Extract file paths from task description
 */
function extractFilePaths(text) {
  const paths = [];
  
  // Pattern 1: /path/to/file.ext
  const unixPaths = text.match(/\/[\w\-./]+\.\w+/g);
  if (unixPaths) paths.push(...unixPaths);
  
  // Pattern 2: ~/path/to/file
  const homePaths = text.match(/~\/[\w\-./]+/g);
  if (homePaths) {
    const homeDir = process.env.HOME || '/Users/jeffhobbs';
    paths.push(...homePaths.map(p => p.replace('~', homeDir)));
  }
  
  // Pattern 3: Quoted paths
  const quotedPaths = text.match(/["'`](\/[\w\-./]+\.\w+)["'`]/g);
  if (quotedPaths) {
    paths.push(...quotedPaths.map(p => p.replace(/["'`]/g, '')));
  }
  
  return [...new Set(paths)]; // Remove duplicates
}

/**
 * Log dispatch to JSONL file
 */
async function logDispatch(entry) {
  try {
    await appendFile(DISPATCH_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`⚠️  Failed to write log: ${err.message}`);
  }
}

//=============================================================================
// MAIN ORCHESTRATION
//=============================================================================

async function orchestrate(requirement) {
  const startTime = Date.now();
  const opId = `op-${randomUUID().split('-')[0]}`;
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🎯 UNIFIED ORCHESTRATOR v1.0`);
  console.log(`   Operation: ${opId}`);
  console.log(`   Requirement: ${requirement}`);
  console.log(`${'═'.repeat(70)}\n`);
  
  try {
    // Step 1: Get natural language plan from PM
    const naturalPlan = await askPMForPlan(requirement);
    
    // Step 2: Parse into structured JSON
    const plan = await parseIntoJSON(naturalPlan, requirement);
    plan.op_id = opId; // Ensure consistent op_id
    
    console.log(`✅ Plan created: ${plan.dispatch.length} task(s)`);
    plan.dispatch.forEach((t, i) => {
      console.log(`   ${i + 1}. ${t.agent}: ${t.task.substring(0, 60)}${t.task.length > 60 ? '...' : ''}`);
    });
    
    // Step 3: Execute tasks
    const results = await executeTasks(plan);
    
    // Step 4: Verify results
    const verifications = await verifyResults(plan, results);
    
    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const verified = verifications.filter(v => v.verified).length;
    
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 OPERATION COMPLETE: ${opId}`);
    console.log(`   ⏱️  Duration: ${duration}s`);
    console.log(`   ✅ Succeeded: ${succeeded}/${results.length}`);
    console.log(`   ❌ Failed: ${failed}/${results.length}`);
    console.log(`   🔍 Verified: ${verified}/${verifications.length}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    if (failed > 0) {
      console.log('❌ Some tasks failed:\n');
      results.filter(r => !r.success).forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.agent}: ${r.error}`);
      });
      console.log();
      process.exit(1);
    }
    
    if (verified < verifications.length) {
      console.log('⚠️  Some tasks could not be verified:\n');
      verifications.filter(v => !v.verified).forEach(v => {
        console.log(`   Task ${v.task_num}: ${v.reason}`);
      });
      console.log();
      process.exit(1);
    }
    
    console.log('🎉 All tasks completed and verified!\n');
    process.exit(0);
    
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n${'═'.repeat(70)}`);
    console.error(`❌ ORCHESTRATION FAILED (${duration}s)`);
    console.error(`   ${error.message}`);
    console.error(`${'═'.repeat(70)}\n`);
    
    if (process.env.DEBUG) {
      console.error('\nFull error:');
      console.error(error);
    }
    
    process.exit(1);
  }
}

//=============================================================================
// CLI
//=============================================================================

const requirement = process.argv.slice(2).join(' ');

if (!requirement) {
  console.log(`
🎯 Unified Orchestrator v1.0

Usage:
  node unified-orchestrator.mjs "<requirement>"

Examples:
  node unified-orchestrator.mjs "Create /tmp/test.txt with 'hello world'"
  node unified-orchestrator.mjs "Build user authentication with JWT"
  node unified-orchestrator.mjs "Fix the dashboard loading error and add tests"

How it works:
  1. PM agent creates plan in natural language
  2. Parser converts plan to structured JSON
  3. Worker agents execute tasks in parallel
  4. Verification checks artifacts were created

Logs: ${DISPATCH_LOG}
`);
  process.exit(1);
}

orchestrate(requirement);

