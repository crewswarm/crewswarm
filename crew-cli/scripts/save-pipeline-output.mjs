#!/usr/bin/env node
/**
 * Extract and save the full pipeline output for quality assessment
 */

import { UnifiedPipeline } from '../src/pipeline/unified.js';
import fs from 'fs';
import { config } from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '..', '.env');
config({ path: envPath });

const TASK = `Build MVP Phase 1 VS Code extension for CrewSwarm.

Output to: /Users/jeffhobbs/Desktop/benchmark-vscode-grok-FULL

Requirements:
1. Extension scaffold (package.json)
2. Webview chat UI with message bridge
3. API client for /v1/chat
4. Action parser, diff handler
5. Status bar, branding

Files: package.json, src/extension.ts, src/api-client.ts, src/webview/chat.html, src/webview/chat.js, src/webview/styles.css, src/diff-handler.ts, README.md, tests/extension.test.ts`;

async function saveOutput() {
  process.env.CREW_USE_UNIFIED_ROUTER = 'true';
  process.env.CREW_DUAL_L2_ENABLED = 'true';
  process.env.CREW_ALLOW_CRITICAL = 'true';
  process.env.CREW_CHAT_MODEL = 'grok-4-1-fast-reasoning';
  process.env.CREW_REASONING_MODEL = 'grok-4-1-fast-reasoning';
  process.env.CREW_EXECUTION_MODEL = 'grok-4-1-fast-reasoning';

  console.log('Running pipeline to save full output...\n');

  const pipeline = new UnifiedPipeline();
  const result = await pipeline.execute({
    userInput: TASK,
    context: 'Extract full output for quality assessment',
    sessionId: `extract-${Date.now()}`
  });

  const outputFile = '/tmp/grok-pipeline-full-output.txt';
  fs.writeFileSync(outputFile, result.response, 'utf8');

  console.log(`\n✅ Full output saved to: ${outputFile}`);
  console.log(`Length: ${result.response.length} chars`);
  console.log(`Cost: $${result.totalCost.toFixed(6)}`);
  console.log(`Time: ${(result.totalTimeMs / 1000).toFixed(1)}s\n`);
}

saveOutput().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
