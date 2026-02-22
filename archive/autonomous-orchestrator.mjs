#!/usr/bin/env node
/**
 * AUTONOMOUS ORCHESTRATOR V2
 * 
 * True autonomous swarm - agents work in parallel and communicate directly.
 * PM dispatches all tasks, agents coordinate via RT channels, PM monitors completion.
 * 
 * Usage:
 *   node autonomous-orchestrator.mjs "Build user authentication system"
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const OPENCLAW_BIN = join(process.env.HOME, 'bin/openswitchctl');
const RT_EVENTS = '/Users/jeffhobbs/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/events.jsonl';
const DONE_CHANNEL = '/Users/jeffhobbs/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/done.jsonl';

// Master orchestration prompt for PM
function createMasterPrompt(requirement) {
  return `AUTONOMOUS ORCHESTRATION: ${requirement}

You are the MASTER ORCHESTRATOR. Your job: dispatch tasks to agents, monitor progress, report when done.

PHASE 1 - ANALYZE & PLAN (Do this NOW):
1. Break "${requirement}" into parallel tasks:
   - Research task (what libraries/standards to use)
   - Implementation task (what files to create)
   - Testing task (what tests to write)
   - Security task (what to audit)
   - Documentation task (what docs to write)
   - UI/UX task (what to polish)

2. Identify dependencies:
   - Testing waits for Implementation
   - Security waits for Implementation
   - Documentation waits for Implementation + Testing + Security
   - Final review waits for everything

PHASE 2 - DISPATCH TASKS (Do this IMMEDIATELY after planning):

Send messages to agents using RT system:

For each task, send a message like:
"@opencode-coder CODING TASK: Implement user authentication system.

Files to create:
- /path/to/login.ts (JWT-based login)
- /path/to/register.ts (user registration with bcrypt)
- /path/to/middleware.ts (auth middleware)

Requirements:
- Production-ready TypeScript
- Proper error handling
- JSDoc comments
- Follow existing project conventions

When done: Reply to @opencode-qa and @security with list of files created."

Key instructions for agents:
- @opencode-pm (YOU): Research best practices, create architecture plan
- @opencode-coder: Implement code, notify @opencode-qa and @security when done
- @opencode-qa: Write tests (>90% coverage), run them, report results
- @security: Audit for vulnerabilities, report findings
- @opencode-pm (YOU): Write docs after implementation/tests/security are done
- @openclaw-main: Final review when all tasks complete

PHASE 3 - MONITOR PROGRESS:
Watch for agent responses in RT channels:
- Track which tasks are complete
- If an agent fails, reassign the task
- When all tasks done, compile final report

PHASE 4 - FINAL REPORT:
When everything is complete, send final status:

"🎉 REQUIREMENT COMPLETE: ${requirement}

✅ Research: [summary]
✅ Implementation: [N files created]
✅ Testing: [N tests, X% coverage]
✅ Security: [audit status]
✅ Documentation: [docs created]
✅ UI/UX: [polish status]

📊 Final Status: PRODUCTION READY ✓

Files created:
[list all files]

Next steps:
[deployment notes if any]"

START NOW - DO ALL PHASES IMMEDIATELY. Don't wait for further instructions.`;
}

// Send message to agent
async function sendMessage(agent, message) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [OPENCLAW_BIN, 'send', agent, message], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to send: ${stderr}`));
      } else {
        try {
          const response = JSON.parse(stdout);
          resolve(response);
        } catch (e) {
          reject(new Error(`Parse error: ${stdout}`));
        }
      }
    });
  });
}

// Monitor RT events for completion
async function monitorProgress(pmTaskId, timeoutMs = 600000) { // 10 min timeout
  console.log('\n⏳ Monitoring swarm progress...\n');
  
  const startTime = Date.now();
  let lastEventCount = 0;
  const stages = new Set();
  
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 seconds
    
    if (!existsSync(DONE_CHANNEL)) continue;
    
    const lines = readFileSync(DONE_CHANNEL, 'utf8').split('\n').filter(Boolean);
    const newEvents = lines.slice(lastEventCount);
    lastEventCount = lines.length;
    
    // Check for PM final report
    for (const line of newEvents) {
      try {
        const event = JSON.parse(line);
        
        // Track stage completions
        if (event.from && event.payload?.reply) {
          const reply = event.payload.reply;
          
          // Detect stage keywords in replies
          if (reply.includes('Research') || reply.includes('RESEARCH')) {
            if (!stages.has('research')) {
              stages.add('research');
              console.log('  ✓ Research complete');
            }
          }
          if (reply.includes('Implementation') || reply.includes('Files Created') || reply.includes('IMPLEMENTATION')) {
            if (!stages.has('implementation')) {
              stages.add('implementation');
              console.log('  ✓ Implementation complete');
            }
          }
          if (reply.includes('Test') || reply.includes('TESTING') || reply.includes('passed')) {
            if (!stages.has('testing')) {
              stages.add('testing');
              console.log('  ✓ Testing complete');
            }
          }
          if (reply.includes('Security') || reply.includes('SECURITY') || reply.includes('audit')) {
            if (!stages.has('security')) {
              stages.add('security');
              console.log('  ✓ Security audit complete');
            }
          }
          if (reply.includes('Documentation') || reply.includes('README')) {
            if (!stages.has('documentation')) {
              stages.add('documentation');
              console.log('  ✓ Documentation complete');
            }
          }
          if (reply.includes('UI/UX') || reply.includes('polished')) {
            if (!stages.has('ui')) {
              stages.add('ui');
              console.log('  ✓ UI/UX complete');
            }
          }
          
          // Check if PM sent final report
          if (event.from === 'opencode-pm' && 
              (reply.includes('REQUIREMENT COMPLETE') || 
               reply.includes('PRODUCTION READY') ||
               reply.includes('Final Status'))) {
            console.log('\n✅ PM reports: COMPLETE\n');
            return reply;
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }
    
    // Progress indicator
    if (newEvents.length > 0) {
      process.stdout.write('.');
    }
  }
  
  throw new Error(`Timeout: Swarm did not complete within ${timeoutMs}ms`);
}

// Main orchestration
async function orchestrate(requirement) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 AUTONOMOUS SWARM ORCHESTRATOR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\nRequirement: ${requirement}\n`);
  
  // Step 1: Send master orchestration task to PM
  console.log('📤 Dispatching master orchestration task to PM...');
  const masterPrompt = createMasterPrompt(requirement);
  const response = await sendMessage('opencode-pm', masterPrompt);
  console.log(`✓ PM received orchestration task (ID: ${response.taskId})\n`);
  
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│ PM IS NOW AUTONOMOUS                        │');
  console.log('│ • Analyzing requirement                     │');
  console.log('│ • Dispatching tasks to agents               │');
  console.log('│ • Monitoring progress                       │');
  console.log('│ • Will report when complete                 │');
  console.log('└─────────────────────────────────────────────┘\n');
  
  // Step 2: Monitor for completion
  try {
    const finalReport = await monitorProgress(response.taskId);
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 SWARM ORCHESTRATION COMPLETE!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(finalReport);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    return finalReport;
  } catch (error) {
    console.error('\n❌ Orchestration failed:', error.message);
    console.log('\n📊 Checking last known status...\n');
    
    // Show last events from PM
    if (existsSync(DONE_CHANNEL)) {
      const lines = readFileSync(DONE_CHANNEL, 'utf8').split('\n').filter(Boolean);
      const pmEvents = lines.slice(-20).filter(line => {
        try {
          const event = JSON.parse(line);
          return event.from === 'opencode-pm';
        } catch (e) {
          return false;
        }
      });
      
      if (pmEvents.length > 0) {
        console.log('Last PM updates:');
        pmEvents.forEach(line => {
          const event = JSON.parse(line);
          console.log(`  - ${new Date(event.ts).toLocaleTimeString()}: ${event.payload.reply.substring(0, 100)}...`);
        });
      }
    }
    
    throw error;
  }
}

// CLI
const requirement = process.argv[2];
if (!requirement) {
  console.error('Usage: node autonomous-orchestrator.mjs "Your requirement here"');
  console.error('\nExamples:');
  console.error('  node autonomous-orchestrator.mjs "Build user authentication system"');
  console.error('  node autonomous-orchestrator.mjs "Create rate limiting middleware"');
  console.error('  node autonomous-orchestrator.mjs "Add dark mode to dashboard"');
  process.exit(1);
}

orchestrate(requirement)
  .then(() => {
    console.log('✅ Orchestration complete! Check files created.\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Orchestration failed:', error.message);
    console.error('Check logs: tail -f /Users/jeffhobbs/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/issues.jsonl\n');
    process.exit(1);
  });

