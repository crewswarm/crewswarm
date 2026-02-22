#!/usr/bin/env node
/**
 * CREW CLI - Unified interface for CrewSwarm multi-agent system
 * 
 * Usage:
 *   crew "Build user auth system"
 *   crew code "Create login endpoint"
 *   crew test "Test auth flow"
 *   crew fix "Debug login timeout"
 *   crew audit "Security review of auth"
 *   crew --watch "Build dashboard"
 *   crew --github "Build payment system"
 */

import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREWSWARM_DIR = process.env.OPENCLAW_DIR || process.env.CREWSWARM_DIR || __dirname;
const ORCHESTRATOR = join(CREWSWARM_DIR, 'natural-pm-orchestrator.mjs');
const WATCH_DIR = process.cwd();

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(color, icon, message) {
  console.log(`${COLORS[color]}${icon} ${message}${COLORS.reset}`);
}

function showUsage() {
  console.log(`
${COLORS.bright}CREW CLI${COLORS.reset} - CrewSwarm Multi-Agent System

${COLORS.cyan}Basic Usage:${COLORS.reset}
  crew "Build user authentication system"
  crew "Fix all linter errors in src/"
  crew "Add JSDoc comments to api.js"

${COLORS.cyan}Specialized Agents:${COLORS.reset}
  crew code  "Create login endpoint"       ${COLORS.dim}→ Routes to crew-coder${COLORS.reset}
  crew test  "Test auth flow"              ${COLORS.dim}→ Routes to crew-qa${COLORS.reset}
  crew fix   "Debug login timeout"         ${COLORS.dim}→ Routes to crew-fixer${COLORS.reset}
  crew audit "Security review"             ${COLORS.dim}→ Routes to crew-security${COLORS.reset}

${COLORS.cyan}Advanced Options:${COLORS.reset}
  crew --watch "Build dashboard"           ${COLORS.dim}→ Watch for file changes${COLORS.reset}
  crew --github "Build payment system"     ${COLORS.dim}→ Create PR when done${COLORS.reset}
  crew --cursor "Refactor auth.js"         ${COLORS.dim}→ Open results in Cursor${COLORS.reset}
  crew --status                            ${COLORS.dim}→ Show crew status${COLORS.reset}

${COLORS.cyan}Examples:${COLORS.reset}
  ${COLORS.dim}# Complex multi-agent task${COLORS.reset}
  crew "Build TODO API with CRUD, tests, and security audit"

  ${COLORS.dim}# Watch mode (see changes in real-time)${COLORS.reset}
  crew --watch "Add dark mode to dashboard"

  ${COLORS.dim}# Auto-create GitHub PR${COLORS.reset}
  crew --github "Implement stripe payment integration"

  ${COLORS.dim}# Quick fix and review in Cursor${COLORS.reset}
  crew --cursor fix "TypeError in login handler"
`);
}

async function runOrchestrator(task, options = {}) {
  const startTime = Date.now();
  const opId = `op-${randomUUID().substring(0, 8)}`;
  
  log('cyan', '🚀', `Starting operation ${opId}`);
  log('blue', '📋', `Task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`);
  
  if (options.watch) {
    log('yellow', '👀', 'Watch mode enabled - monitoring for file changes...');
  }
  
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [ORCHESTRATOR, task], {
      cwd: OPENCLAW_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    
    let stdout = '';
    let stderr = '';
    const changedFiles = new Set();
    
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      
      // Extract file paths from output
      const fileMatches = text.match(/(?:Created|Modified|Updated|Wrote)\s+([^\s]+\.[a-zA-Z]+)/gi);
      if (fileMatches) {
        fileMatches.forEach(match => {
          const filePath = match.split(/\s+/)[1];
          changedFiles.add(filePath);
        });
      }
      
      if (options.watch) {
        process.stdout.write(data);
      }
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (options.watch) {
        process.stderr.write(data);
      }
    });
    
    proc.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      if (code === 0) {
        log('green', '✅', `Operation completed in ${duration}s`);
        
        if (changedFiles.size > 0) {
          log('blue', '📁', `Files modified: ${changedFiles.size}`);
          Array.from(changedFiles).slice(0, 5).forEach(file => {
            console.log(`   ${COLORS.dim}→ ${file}${COLORS.reset}`);
          });
          if (changedFiles.size > 5) {
            console.log(`   ${COLORS.dim}... and ${changedFiles.size - 5} more${COLORS.reset}`);
          }
        }
        
        resolve({
          success: true,
          opId,
          duration,
          changedFiles: Array.from(changedFiles),
          stdout,
        });
      } else {
        log('red', '❌', `Operation failed (code ${code})`);
        reject(new Error(stderr || stdout));
      }
    });
    
    proc.on('error', (err) => {
      log('red', '💥', `Failed to start orchestrator: ${err.message}`);
      reject(err);
    });
  });
}

async function createGitHubPR(result, task) {
  log('cyan', '📦', 'Creating GitHub commit and PR...');
  
  if (result.changedFiles.length === 0) {
    log('yellow', '⚠️', 'No files changed, skipping GitHub PR');
    return;
  }
  
  const branchName = `crew/${result.opId}`;
  const commitMessage = task.length > 72 ? task.substring(0, 69) + '...' : task;
  
  try {
    // Create branch
    await execCommand(`git checkout -b ${branchName}`);
    log('green', '✓', `Created branch: ${branchName}`);
    
    // Stage files
    for (const file of result.changedFiles) {
      if (existsSync(file)) {
        await execCommand(`git add "${file}"`);
      }
    }
    
    // Commit
    await execCommand(`git commit -m "feat: ${commitMessage}

Generated by CrewSwarm
Operation ID: ${result.opId}
Duration: ${result.duration}s

Files changed:
${result.changedFiles.map(f => `- ${f}`).join('\n')}"`);
    
    log('green', '✓', 'Committed changes');
    
    // Push
    await execCommand(`git push origin ${branchName}`);
    log('green', '✓', `Pushed to origin/${branchName}`);
    
    // Create PR (if gh CLI is available)
    try {
      await execCommand(`gh pr create --title "feat: ${commitMessage}" --body "**Auto-generated by CrewSwarm**

## Task
${task}

## Details
- Operation ID: \`${result.opId}\`
- Duration: ${result.duration}s
- Files changed: ${result.changedFiles.length}

## Files Modified
${result.changedFiles.map(f => `- \`${f}\``).join('\n')}

---
*This PR was created automatically by CrewSwarm.*" --web`);
      
      log('green', '🎉', 'Pull request created!');
    } catch (err) {
      log('yellow', '⚠️', 'GitHub CLI not available. Push successful, but PR not created.');
      log('blue', '💡', `Create PR manually: https://github.com/your-repo/compare/${branchName}`);
    }
    
  } catch (err) {
    log('red', '❌', `GitHub operation failed: ${err.message}`);
    // Cleanup
    try {
      await execCommand('git checkout -');
      await execCommand(`git branch -D ${branchName}`);
    } catch {}
  }
}

async function openInCursor(files) {
  if (files.length === 0) {
    log('yellow', '⚠️', 'No files to open in Cursor');
    return;
  }
  
  log('cyan', '📝', 'Opening files in Cursor...');
  
  try {
    // Open first 10 files
    const filesToOpen = files.slice(0, 10).filter(f => existsSync(f));
    if (filesToOpen.length > 0) {
      await execCommand(`cursor ${filesToOpen.join(' ')}`);
      log('green', '✓', `Opened ${filesToOpen.length} file(s) in Cursor`);
    }
  } catch (err) {
    log('red', '❌', `Failed to open Cursor: ${err.message}`);
  }
}

function execCommand(cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout));
      }
    });
  });
}

async function showStatus() {
  log('cyan', '📊', 'Crew Status');
  console.log('');
  
  try {
    // Check crew-lead
    await execCommand('curl -sf http://127.0.0.1:5010/health');
    log('green', '✓', 'crew-lead: Running (port 5010)');
  } catch {
    log('red', '✗', 'crew-lead: Stopped (run: node crew-lead.mjs)');
  }

  try {
    // Check RT bus
    await execCommand('curl -sf http://127.0.0.1:18889/health || nc -z 127.0.0.1 18889');
    log('green', '✓', 'RT bus: Running (port 18889)');
  } catch {
    log('red', '✗', 'RT bus: Stopped (run: npm run restart-all)');
  }

  try {
    // Check dashboard
    await execCommand('curl -sf http://127.0.0.1:4319');
    log('green', '✓', 'Dashboard: Running (port 4319)');
  } catch {
    log('red', '✗', 'Dashboard: Stopped');
  }
  
  try {
    // Check agent daemons
    const status = await execCommand('bash ~/bin/openswitchctl status 2>&1 | head -n 1');
    console.log(`\n${status.trim()}`);
  } catch {
    log('yellow', '⚠️', 'Could not get agent status');
  }
  
  console.log('');
}

// Main CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showUsage();
    process.exit(0);
  }
  
  if (args.includes('--status')) {
    await showStatus();
    process.exit(0);
  }
  
  const options = {
    watch: args.includes('--watch'),
    github: args.includes('--github'),
    cursor: args.includes('--cursor'),
  };
  
  // Extract task
  const specialCommands = ['code', 'test', 'fix', 'audit'];
  let task = '';
  
  if (specialCommands.includes(args[0])) {
    const agentMap = {
      'code': 'Codex should',
      'test': 'Tester should',
      'fix': 'Fixer should',
      'audit': 'Security should audit',
    };
    const prefix = agentMap[args[0]];
    task = `${prefix} ${args.slice(1).filter(a => !a.startsWith('--')).join(' ')}`;
  } else {
    task = args.filter(a => !a.startsWith('--')).join(' ');
  }
  
  if (!task) {
    log('red', '❌', 'No task specified');
    showUsage();
    process.exit(1);
  }
  
  try {
    const result = await runOrchestrator(task, options);
    
    if (options.github && result.success) {
      await createGitHubPR(result, task);
    }
    
    if (options.cursor && result.success) {
      await openInCursor(result.changedFiles);
    }
    
    process.exit(0);
  } catch (err) {
    log('red', '💥', err.message);
    process.exit(1);
  }
}

main();

