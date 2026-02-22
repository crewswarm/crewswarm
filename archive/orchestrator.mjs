#!/usr/bin/env node
/**
 * AUTONOMOUS ORCHESTRATOR
 * 
 * Implements a full enterprise dev pipeline:
 * 1. Research → 2. Architecture → 3. Implementation → 4. Testing → 5. Security → 6. Documentation → 7. UI/UX → 8. Review
 * 
 * Usage:
 *   node orchestrator.mjs "Build user authentication system"
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const OPENCLAW_BIN = join(process.env.HOME, 'bin/openswitchctl');
const PIPELINE_LOG = '/tmp/openclaw-pipeline.jsonl';

// Full dev pipeline stages
const PIPELINE_STAGES = [
  {
    name: 'RESEARCH',
    agent: 'opencode-pm',
    description: 'Research best practices, libraries, and standards',
    prompt: (requirement) => `RESEARCH TASK: ${requirement}

Your job: Find the best approach for this requirement.

Steps:
1. Use web_search to find:
   - Best libraries/frameworks for this
   - Industry standards and best practices
   - Security considerations
   - Performance benchmarks
2. Compare 3+ options
3. Recommend the best approach with reasoning

Output format:
- Recommended approach: [choice]
- Why: [reasoning]
- Key libraries: [list]
- Security considerations: [list]
- Architecture notes: [notes]`,
    validation: (result) => result.includes('Recommended approach')
  },
  
  {
    name: 'ARCHITECTURE',
    agent: 'opencode-pm',
    description: 'Design the architecture and create implementation plan',
    prompt: (requirement, research) => `ARCHITECTURE TASK: ${requirement}

Research findings:
${research}

Your job: Create a detailed implementation plan.

Steps:
1. Design file structure (which files to create)
2. Define API contracts (inputs/outputs)
3. Plan database schema (if needed)
4. Identify dependencies between components
5. Create task list for implementation

Output format:
## Files to Create
- file1.ts: [purpose]
- file2.ts: [purpose]

## Implementation Tasks
1. [Task for Codex]
2. [Task for Codex]

## Dependencies
- External: [npm packages]
- Internal: [which files depend on what]

## Quality Requirements
- Test coverage: >90%
- Performance: [targets]
- Security: [requirements]`,
    validation: (result) => result.includes('## Files to Create') && result.includes('## Implementation Tasks')
  },
  
  {
    name: 'IMPLEMENTATION',
    agent: 'opencode-coder',
    description: 'Write production-ready code',
    prompt: (requirement, architecture) => `CODING TASK: ${requirement}

Architecture plan:
${architecture}

Your job: Implement ALL files according to the plan.

Requirements:
- Write clean, typed, production-ready code
- Include JSDoc comments for all functions
- Proper error handling (try-catch)
- Follow existing project conventions
- Use TypeScript with strict types
- Add inline comments for complex logic

For EACH file you create:
1. Read similar existing files first (to match style)
2. Write the implementation
3. Verify syntax is correct

Output format:
## Files Created
- /path/to/file1.ts (234 lines)
- /path/to/file2.ts (156 lines)

## Implementation Notes
- [Key decisions made]
- [Challenges solved]

Report ALL file paths you created.`,
    validation: (result) => result.includes('## Files Created') && result.includes('/') && result.includes('.ts')
  },
  
  {
    name: 'TESTING',
    agent: 'opencode-qa',
    description: 'Write comprehensive tests',
    prompt: (requirement, implementation) => `TESTING TASK: ${requirement}

Implementation summary:
${implementation}

Your job: Write comprehensive tests for ALL implemented code.

Test types required:
1. Unit tests (test each function)
2. Integration tests (test components together)
3. Edge cases (empty inputs, null, undefined)
4. Error cases (invalid inputs, exceptions)
5. Performance tests (if applicable)

Requirements:
- Use Jest or Vitest
- Aim for >90% code coverage
- Test both success and failure paths
- Use proper mocking for external deps
- Clear test names (describe what is tested)

Output format:
## Test Files Created
- tests/file1.test.ts (15 tests)
- tests/file2.test.ts (23 tests)

## Test Results
\`\`\`
npm test
...
PASS  tests/file1.test.ts
PASS  tests/file2.test.ts
Tests: 38 passed, 38 total
Coverage: 94.2%
\`\`\`

## Coverage Report
- file1.ts: 96% coverage
- file2.ts: 92% coverage

Report ALL test results.`,
    validation: (result) => result.includes('Test Files Created') && (result.includes('passed') || result.includes('PASS'))
  },
  
  {
    name: 'SECURITY_AUDIT',
    agent: 'security',
    description: 'Security review and vulnerability assessment',
    prompt: (requirement, implementation) => `SECURITY AUDIT: ${requirement}

Implementation summary:
${implementation}

Your job: Perform a comprehensive security audit.

Check for:
1. SQL Injection vulnerabilities
2. XSS (Cross-Site Scripting)
3. CSRF protection
4. Authentication/Authorization issues
5. Sensitive data exposure (API keys, passwords)
6. Input validation and sanitization
7. Rate limiting
8. Secure dependencies (npm audit)

Steps:
1. Read all implemented files
2. Check for each vulnerability type
3. Run: npm audit (check for vulnerable deps)
4. Test authentication bypass attempts
5. Verify encryption/hashing is used correctly

Output format:
## Security Audit Results

### Critical Issues (MUST FIX)
- [None found] OR [List with severity]

### Warnings (SHOULD FIX)
- [Issues with line numbers]

### Recommendations
- [Best practices to add]

### Dependencies Audit
\`\`\`
npm audit
...
found 0 vulnerabilities
\`\`\`

### Approval Status
[APPROVED] or [BLOCKED - issues must be fixed]`,
    validation: (result) => result.includes('Security Audit Results') && result.includes('Approval Status')
  },
  
  {
    name: 'DOCUMENTATION',
    agent: 'opencode-pm',
    description: 'Create comprehensive documentation',
    prompt: (requirement, implementation, tests, security) => `DOCUMENTATION TASK: ${requirement}

Implementation:
${implementation}

Tests:
${tests}

Security:
${security}

Your job: Create complete documentation.

Required docs:
1. README.md - Setup and usage
2. API.md - All endpoints with examples
3. SECURITY.md - Security considerations
4. CONTRIBUTING.md - How to contribute

README.md should include:
- What this does (1-2 sentences)
- Installation steps
- Usage examples (code samples)
- Configuration options
- Testing instructions
- Common issues / FAQ

API.md should include:
- All endpoints with method (GET/POST/etc)
- Request format (with example JSON)
- Response format (with example JSON)
- Error codes and meanings
- Authentication requirements

Output format:
## Documentation Files Created
- README.md (created)
- API.md (created)
- SECURITY.md (created)

## README.md Preview
\`\`\`markdown
# [Feature Name]

[First 10 lines...]
\`\`\`

Report ALL doc files created with previews.`,
    validation: (result) => result.includes('Documentation Files Created') && result.includes('README.md')
  },
  
  {
    name: 'UI_UX',
    agent: 'opencode-coder',
    description: 'Polish UI/UX (if applicable)',
    prompt: (requirement, implementation) => `UI/UX TASK: ${requirement}

Implementation:
${implementation}

Your job: Make the UI beautiful and user-friendly.

If this has a user interface:
1. Review existing UI components
2. Ensure responsive design (mobile, tablet, desktop)
3. Add proper loading states
4. Add error states with helpful messages
5. Use consistent colors/spacing from globals.css
6. Add hover effects and transitions
7. Ensure accessibility (ARIA labels)
8. Test keyboard navigation

If no UI needed:
- Reply: "No UI component - CLI/API only"

Requirements (if UI exists):
- Clean, modern design
- Smooth animations (use Tailwind classes)
- Clear error messages
- Loading indicators
- Mobile-responsive

Output format:
## UI Components Updated
- components/LoginForm.tsx (polished)
- pages/dashboard.tsx (responsive)

## UX Improvements
- Added loading spinner
- Improved error messages
- Mobile breakpoints added
- Keyboard navigation works

## Design Decisions
- [Color scheme reasoning]
- [Layout choices]`,
    validation: (result) => result.includes('UI') || result.includes('No UI component')
  },
  
  {
    name: 'FINAL_REVIEW',
    agent: 'opencode-pm',
    description: 'Final quality check and summary',
    prompt: (requirement, allResults) => `FINAL REVIEW: ${requirement}

Pipeline results:
${allResults}

Your job: Verify everything is complete and production-ready.

Checklist:
□ All files created and working
□ Tests written and passing (>90% coverage)
□ Security audit passed (no critical issues)
□ Documentation complete (README, API docs)
□ UI polished (if applicable)
□ No console.log or debug code
□ No TODO comments
□ Code follows project conventions

Steps:
1. Read a sample of the created files
2. Verify tests exist and pass
3. Check security audit approved
4. Verify docs are complete
5. Run final smoke test if possible

Output format:
# FINAL REVIEW REPORT

## ✅ Completed
- [X] Implementation: N files created
- [X] Testing: N tests passing, X% coverage
- [X] Security: Audit passed, 0 critical issues
- [X] Documentation: README, API docs complete
- [X] UI/UX: Polished and responsive

## 📊 Summary
- Files created: [list]
- Tests: N passed, 0 failed
- Coverage: X%
- Security: APPROVED
- Status: PRODUCTION READY ✓

## 🚀 Ready to Deploy
[Yes/No] + reasoning

## 📝 Handoff Notes
- [Important notes for user]
- [Known limitations]
- [Next steps if any]`,
    validation: (result) => result.includes('FINAL REVIEW REPORT') && result.includes('PRODUCTION READY')
  }
];

// Send task to agent via openswitchctl
async function sendToAgent(agent, prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [OPENCLAW_BIN, 'send', agent, prompt], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`openswitchctl failed: ${stderr}`));
      } else {
        try {
          const response = JSON.parse(stdout);
          resolve(response);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${stdout}`));
        }
      }
    });
  });
}

// Wait for agent to complete task (poll done channel)
async function waitForCompletion(agent, taskId, timeoutMs = 180000) {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5 seconds
    
    // Check done channel for this agent
    const doneLog = '/Users/jeffhobbs/.openclaw/workspace/shared-memory/claw-swarm/opencrew-rt/channels/done.jsonl';
    if (!existsSync(doneLog)) continue;
    
    const lines = readFileSync(doneLog, 'utf8').split('\n').filter(Boolean);
    const recentLines = lines.slice(-50); // Check last 50 events
    
    for (const line of recentLines) {
      try {
        const event = JSON.parse(line);
        if (event.from === agent && event.taskId === taskId) {
          return event.payload.reply;
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }
  
  throw new Error(`Agent ${agent} did not complete task ${taskId} within ${timeoutMs}ms`);
}

// Log pipeline progress
function logPipeline(stage, status, details = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    stage,
    status,
    ...details
  };
  
  const logLine = JSON.stringify(logEntry) + '\n';
  writeFileSync(PIPELINE_LOG, logLine, { flag: 'a' });
  
  console.log(`[${stage}] ${status}`);
}

// Run the full pipeline
async function runPipeline(requirement) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 FULL DEV PIPELINE STARTED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Requirement: ${requirement}\n`);
  
  const results = {};
  
  for (const stage of PIPELINE_STAGES) {
    console.log(`\n┌─────────────────────────────────────────┐`);
    console.log(`│ STAGE: ${stage.name.padEnd(35)} │`);
    console.log(`│ AGENT: ${stage.agent.padEnd(35)} │`);
    console.log(`└─────────────────────────────────────────┘`);
    
    logPipeline(stage.name, 'STARTED', { agent: stage.agent });
    
    try {
      // Build prompt with previous stage results
      let prompt;
      if (stage.name === 'RESEARCH') {
        prompt = stage.prompt(requirement);
      } else if (stage.name === 'ARCHITECTURE') {
        prompt = stage.prompt(requirement, results.RESEARCH);
      } else if (stage.name === 'IMPLEMENTATION') {
        prompt = stage.prompt(requirement, results.ARCHITECTURE);
      } else if (stage.name === 'TESTING') {
        prompt = stage.prompt(requirement, results.IMPLEMENTATION);
      } else if (stage.name === 'SECURITY_AUDIT') {
        prompt = stage.prompt(requirement, results.IMPLEMENTATION);
      } else if (stage.name === 'DOCUMENTATION') {
        prompt = stage.prompt(requirement, results.IMPLEMENTATION, results.TESTING, results.SECURITY_AUDIT);
      } else if (stage.name === 'UI_UX') {
        prompt = stage.prompt(requirement, results.IMPLEMENTATION);
      } else if (stage.name === 'FINAL_REVIEW') {
        const allResults = Object.entries(results).map(([k, v]) => `${k}:\n${v}\n`).join('\n');
        prompt = stage.prompt(requirement, allResults);
      }
      
      // Send task to agent
      console.log(`📤 Sending task to ${stage.agent}...`);
      const response = await sendToAgent(stage.agent, prompt);
      console.log(`✓ Task dispatched (ID: ${response.taskId})`);
      
      // Wait for completion
      console.log(`⏳ Waiting for ${stage.agent} to complete...`);
      const result = await waitForCompletion(stage.agent, response.taskId);
      
      // Validate result
      if (!stage.validation(result)) {
        throw new Error(`Stage validation failed: ${stage.name}`);
      }
      
      results[stage.name] = result;
      logPipeline(stage.name, 'COMPLETED', { result: result.substring(0, 200) });
      console.log(`✅ ${stage.name} completed successfully\n`);
      
    } catch (error) {
      logPipeline(stage.name, 'FAILED', { error: error.message });
      console.error(`❌ ${stage.name} failed: ${error.message}`);
      throw error;
    }
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 PIPELINE COMPLETE!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  console.log(results.FINAL_REVIEW);
  
  return results;
}

// Main
const requirement = process.argv[2];
if (!requirement) {
  console.error('Usage: node orchestrator.mjs "Your requirement here"');
  process.exit(1);
}

runPipeline(requirement)
  .then(() => {
    console.log('\n✅ All stages completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Pipeline failed:', error.message);
    process.exit(1);
  });

