#!/usr/bin/env node
/**
 * AI ORCHESTRATOR FOR OPENCLAW
 * 
 * You bark orders → AI creates task JSON → orchestrator.sh assigns to agents → perfect code
 * 
 * Uses OpenClaw's native task queue + RT dispatch system
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const TASKS_DIR = join(process.env.HOME, '.openclaw/workspace/shared-memory/tasks');
const OPENCLAW_BIN = join(process.env.HOME, 'bin/openswitchctl');

// Ensure tasks directory exists
if (!existsSync(TASKS_DIR)) {
  mkdirSync(TASKS_DIR, { recursive: true });
}

// Send to PM: Analyze requirement and create task breakdown
async function analyzeRequirement(requirement) {
  const prompt = `TASK ANALYSIS: ${requirement}

Your job: Analyze this requirement and break it into concrete tasks for agents.

For each task, provide:
1. **title** - Short description (e.g., "Implement user authentication")
2. **description** - Detailed implementation steps
3. **assignee** - Which agent (opencode-coder, opencode-qa, security, opencode-pm, opencode-fixer)
4. **priority** - critical, high, medium, or low
5. **acceptance** - Success criteria (list of checkboxes)
6. **dependencies** - Task IDs that must complete first (if any)

Output ONLY a JSON array like this:
\`\`\`json
[
  {
    "title": "Research authentication libraries",
    "description": "Search for best JWT libraries, compare bcrypt vs argon2, review OWASP standards",
    "assignee": "opencode-pm",
    "priority": "high",
    "acceptance": ["Recommended approach documented", "Security considerations listed"],
    "dependencies": []
  },
  {
    "title": "Implement login endpoint",
    "description": "Create /api/auth/login.ts with JWT generation, bcrypt password check, error handling",
    "assignee": "opencode-coder",
    "priority": "high",
    "acceptance": ["File created", "Tests pass", "Error handling works"],
    "dependencies": ["task-001"]
  },
  {
    "title": "Write authentication tests",
    "description": "Test login success, invalid password, missing fields, expired tokens",
    "assignee": "opencode-qa",
    "priority": "high",
    "acceptance": ["15+ tests written", "All tests pass", ">90% coverage"],
    "dependencies": ["task-002"]
  },
  {
    "title": "Security audit auth system",
    "description": "Check for SQL injection, timing attacks, password storage, token validation",
    "assignee": "security",
    "priority": "critical",
    "acceptance": ["Audit report complete", "No critical vulnerabilities", "Recommendations documented"],
    "dependencies": ["task-002"]
  }
]
\`\`\`

Analyze: "${requirement}"`;

  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [OPENCLAW_BIN, 'send', 'opencode-pm', prompt], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PM analysis failed: ${stderr}`));
      } else {
        resolve(JSON.parse(stdout).taskId);
      }
    });
  });
}

// Wait for PM response
async function waitForAnalysis(taskId) {
  console.log('⏳ Waiting for PM to analyze requirement...\n');
  
  // Poll done channel for PM response
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const doneLog = join(process.env.HOME, '.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/done.jsonl');
    if (!existsSync(doneLog)) continue;
    
    const { readFileSync } = await import('fs');
    const lines = readFileSync(doneLog, 'utf8').split('\n').filter(Boolean);
    
    for (const line of lines.slice(-20)) {
      try {
        const event = JSON.parse(line);
        if (event.from === 'opencode-pm' && event.taskId === taskId) {
          const reply = event.payload.reply;
          
          // Extract JSON from reply
          const jsonMatch = reply.match(/```json\n([\s\S]*?)\n```/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[1]);
          }
          
          // Try parsing the whole reply as JSON
          try {
            return JSON.parse(reply);
          } catch (e) {
            throw new Error('PM did not return valid JSON task breakdown');
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }
  
  throw new Error('PM analysis timeout (2 minutes)');
}

// Create task JSON files
function createTaskFiles(tasks) {
  const taskFiles = [];
  
  tasks.forEach((task, index) => {
    const taskId = `task-${Date.now()}-${index}`;
    const taskFile = join(TASKS_DIR, `${taskId}.json`);
    
    const taskData = {
      id: taskId,
      ...task,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    writeFileSync(taskFile, JSON.stringify(taskData, null, 2));
    taskFiles.push(taskFile);
    
    console.log(`  ✓ Created: ${taskId}`);
    console.log(`    Title: ${task.title}`);
    console.log(`    Assignee: ${task.assignee}`);
    console.log(`    Priority: ${task.priority}\n`);
  });
  
  return taskFiles;
}

// Start orchestrator (if not running)
function ensureOrchestratorRunning() {
  const { execSync } = require('child_process');
  try {
    execSync('pgrep -f orchestrator.sh', { stdio: 'ignore' });
    console.log('✓ Orchestrator already running\n');
  } catch (e) {
    console.log('🚀 Starting orchestrator...\n');
    const orchScript = join(process.env.HOME, '.openclaw/workspace/skills/swarm_mcp/orchestrator.sh');
    spawn('bash', [orchScript], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  }
}

// Main
const requirement = process.argv[2];
if (!requirement) {
  console.error('Usage: node ai-orchestrator.mjs "Your requirement here"');
  console.error('\nExamples:');
  console.error('  node ai-orchestrator.mjs "Build user authentication with JWT"');
  console.error('  node ai-orchestrator.mjs "Create rate limiting middleware"');
  process.exit(1);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🤖 AI ORCHESTRATOR FOR OPENCLAW');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log(`Requirement: ${requirement}\n`);

(async () => {
  try {
    // Step 1: PM analyzes and creates task breakdown
    console.log('┌─────────────────────────────────────────┐');
    console.log('│ STEP 1: AI Task Analysis (PM)          │');
    console.log('└─────────────────────────────────────────┘\n');
    
    const taskId = await analyzeRequirement(requirement);
    const tasks = await waitForAnalysis(taskId);
    
    console.log(`✅ PM created ${tasks.length} tasks\n`);
    
    // Step 2: Create task JSON files
    console.log('┌─────────────────────────────────────────┐');
    console.log('│ STEP 2: Creating Task Queue            │');
    console.log('└─────────────────────────────────────────┘\n');
    
    const taskFiles = createTaskFiles(tasks);
    
    // Step 3: Ensure orchestrator is running
    console.log('┌─────────────────────────────────────────┐');
    console.log('│ STEP 3: Starting Orchestrator          │');
    console.log('└─────────────────────────────────────────┘\n');
    
    ensureOrchestratorRunning();
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ TASKS QUEUED - AGENTS WILL PROCESS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('Tasks created in:', TASKS_DIR);
    console.log('\nMonitor progress:');
    console.log(`  tail -f ${TASKS_DIR}/*.json`);
    console.log('  http://127.0.0.1:4318\n');
    
    console.log('The orchestrator will:');
    console.log('  1. Pick up pending tasks every 30s');
    console.log('  2. Assign to specified agents');
    console.log('  3. Retry failures automatically');
    console.log('  4. Route to DLQ after max attempts\n');
    
  } catch (error) {
    console.error('\n❌ Orchestration failed:', error.message);
    process.exit(1);
  }
})();

