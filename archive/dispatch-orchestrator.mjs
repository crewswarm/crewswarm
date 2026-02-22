#!/usr/bin/env node
/**
 * External Dispatch Orchestrator
 * 
 * Reads DISPATCH JSON from PM agent and performs actual task dispatching.
 * This pattern is more reliable than asking LLMs to call exec multiple times.
 * 
 * Inspired by:
 * - OpenAI Swarm handoff pattern
 * - LangGraph supervisor pattern  
 * - opencode-agent-swarm-demo
 */

import { spawn } from 'node:child_process';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/Users/jeffhobbs/Desktop/OpenClaw';
const GATEWAY_BRIDGE = join(OPENCLAW_DIR, 'gateway-bridge.mjs');
const LOG_DIR = join(OPENCLAW_DIR, 'orchestrator-logs');
const DISPATCH_LOG = join(LOG_DIR, 'dispatch.jsonl');

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  await mkdir(LOG_DIR, { recursive: true });
}

/**
 * Call PM agent to get DISPATCH JSON
 */
async function getPlanFromPM(requirement) {
  console.log('📋 Asking PM to create dispatch plan...\n');
  
  return new Promise((resolve, reject) => {
    // Call gateway-bridge directly (no --send flag exists)
    // Set OPENCREW_RT_AGENT env to route to PM
    const proc = spawn('node', [GATEWAY_BRIDGE, requirement], {
      cwd: OPENCLAW_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCREW_RT_AGENT: 'opencode-pm', // Route to PM agent
      },
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data); // Show real-time output
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PM agent failed (code ${code}): ${stderr}`));
        return;
      }
      
      // Extract JSON from PM's response
      const jsonMatch = stdout.match(/\{[\s\S]*"dispatch"[\s\S]*\}/);
      if (!jsonMatch) {
        reject(new Error(`PM did not output valid DISPATCH JSON.\n\nPM's reply:\n${stdout}`));
        return;
      }
      
      try {
        const dispatchPlan = JSON.parse(jsonMatch[0]);
        
        // Validation: Prevent silent no-ops
        if (!dispatchPlan.dispatch || !Array.isArray(dispatchPlan.dispatch)) {
          reject(new Error('PM output missing "dispatch" array'));
          return;
        }
        
        if (dispatchPlan.dispatch.length === 0) {
          reject(new Error('PM did not dispatch any tasks (empty dispatch array)'));
          return;
        }
        
        // Validate each dispatch entry
        for (const [index, task] of dispatchPlan.dispatch.entries()) {
          if (!task.agent) {
            reject(new Error(`Dispatch task ${index + 1} missing "agent" field`));
            return;
          }
          if (!task.task) {
            reject(new Error(`Dispatch task ${index + 1} missing "task" field`));
            return;
          }
        }
        
        resolve(dispatchPlan);
      } catch (err) {
        reject(new Error(`Failed to parse PM's JSON: ${err.message}\n\nExtracted text:\n${jsonMatch[0]}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn PM agent: ${err.message}`));
    });
  });
}

/**
 * Dispatch a single task to an agent
 */
async function dispatchTask(agent, task, taskIndex, operationId) {
  const taskId = `${operationId}-task-${taskIndex + 1}`;
  console.log(`\n📤 Dispatching to ${agent}...`);
  console.log(`   Task: ${task.substring(0, 80)}${task.length > 80 ? '...' : ''}`);
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    operation_id: operationId,
    task_id: taskId,
    agent,
    task,
    status: 'dispatched',
  };
  
  await appendFile(DISPATCH_LOG, JSON.stringify(logEntry) + '\n');
  
  return new Promise((resolve, reject) => {
    // Call gateway-bridge directly (no --send flag exists)
    const proc = spawn('node', [GATEWAY_BRIDGE, task], {
      cwd: OPENCLAW_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCREW_RT_AGENT: agent, // Route to specified agent
      },
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', async (code) => {
      if (code === 0) {
        console.log(`   ✅ ${agent} completed`);
        logEntry.status = 'completed';
        logEntry.output_preview = stdout.substring(0, 200);
        await appendFile(DISPATCH_LOG, JSON.stringify(logEntry) + '\n');
        resolve({ success: true, agent, taskId, output: stdout });
      } else {
        console.log(`   ❌ ${agent} failed (code ${code})`);
        logEntry.status = 'failed';
        logEntry.error = stderr.substring(0, 500);
        await appendFile(DISPATCH_LOG, JSON.stringify(logEntry) + '\n');
        resolve({ success: false, agent, taskId, error: stderr });
      }
    });
    
    proc.on('error', async (err) => {
      console.log(`   💥 ${agent} crashed: ${err.message}`);
      logEntry.status = 'error';
      logEntry.error = err.message;
      await appendFile(DISPATCH_LOG, JSON.stringify(logEntry) + '\n');
      resolve({ success: false, agent, taskId, error: err.message });
    });
  });
}

/**
 * Execute the dispatch plan
 */
async function executeDispatchPlan(plan) {
  const operationId = plan.operation_id || randomUUID();
  const totalTasks = plan.dispatch.length;
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🎯 EXECUTING DISPATCH PLAN: ${operationId}`);
  console.log(`   Master Task: ${plan.master_task}`);
  console.log(`   Subtasks: ${totalTasks}`);
  console.log(`${'='.repeat(70)}\n`);
  
  const results = [];
  
  // Dispatch all tasks in parallel (for now - can add dependency handling later)
  const dispatchPromises = plan.dispatch.map((subtask, index) => 
    dispatchTask(subtask.agent, subtask.task, index, operationId)
  );
  
  const taskResults = await Promise.all(dispatchPromises);
  results.push(...taskResults);
  
  // Summary
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 OPERATION COMPLETE: ${operationId}`);
  console.log(`   ✅ Succeeded: ${succeeded}/${totalTasks}`);
  console.log(`   ❌ Failed: ${failed}/${totalTasks}`);
  
  if (plan.acceptance && plan.acceptance.length > 0) {
    console.log(`\n   Acceptance Criteria:`);
    plan.acceptance.forEach((criterion, i) => {
      console.log(`   ${i + 1}. ${criterion}`);
    });
  }
  
  console.log(`${'='.repeat(70)}\n`);
  
  if (failed > 0) {
    console.log(`⚠️  Some tasks failed. Check logs in ${DISPATCH_LOG}`);
    console.log(`   Failed tasks:`);
    results.filter(r => !r.success).forEach(r => {
      console.log(`   - ${r.agent}: ${r.error?.substring(0, 100)}`);
    });
  }
  
  return {
    operation_id: operationId,
    total: totalTasks,
    succeeded,
    failed,
    results,
  };
}

/**
 * Main orchestration flow
 */
async function orchestrate(requirement) {
  const startTime = Date.now();
  
  try {
    // Step 1: Get dispatch plan from PM
    const plan = await getPlanFromPM(requirement);
    
    console.log(`\n✅ PM created dispatch plan with ${plan.dispatch.length} subtasks\n`);
    
    // Step 2: Execute the plan
    const summary = await executeDispatchPlan(plan);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n⏱️  Total time: ${duration}s\n`);
    
    if (summary.failed === 0) {
      console.log('🎉 All tasks completed successfully!\n');
      process.exit(0);
    } else {
      console.log(`⚠️  ${summary.failed} task(s) failed. Check logs for details.\n`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error(`\n❌ Orchestration failed: ${error.message}\n`);
    console.error(`\nFull error:`);
    console.error(error);
    process.exit(1);
  }
}

// CLI
const requirement = process.argv.slice(2).join(' ');

if (!requirement) {
  console.log(`
🎯 External Dispatch Orchestrator

Usage:
  node dispatch-orchestrator.mjs "<your requirement>"

Examples:
  node dispatch-orchestrator.mjs "Build user authentication with JWT"
  node dispatch-orchestrator.mjs "Fix the dashboard loading error"
  node dispatch-orchestrator.mjs "Add tests for the API endpoints"

How it works:
  1. Asks PM agent to output DISPATCH JSON
  2. Parses the JSON to get subtasks
  3. Dispatches each subtask to the appropriate agent
  4. Monitors completion and reports results

Logs: ${DISPATCH_LOG}
`);
  process.exit(1);
}

console.log(`\n🚀 Starting orchestration...\n`);
orchestrate(requirement);

