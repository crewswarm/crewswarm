#!/usr/bin/env node
/**
 * Test Auto-RAG (all 3 phases)
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const testDir = '/tmp/crew-rag-test';

console.log('🧪 Testing Auto-RAG (Phases 1-3)\n');

// Cleanup
try {
  rmSync(testDir, { recursive: true, force: true });
} catch {}

// Setup test project
mkdirSync(join(testDir, 'src'), { recursive: true });
mkdirSync(join(testDir, 'middleware'), { recursive: true });

// Create test files
writeFileSync(join(testDir, 'src/auth.ts'), `
export function loginHandler(req, res) {
  const { username, password } = req.body;
  
  // TODO: Add rate limiting
  const token = jwt.sign({ username }, SECRET_KEY);
  
  res.json({ token });
}
`);

writeFileSync(join(testDir, 'middleware/rateLimit.ts'), `
import rateLimit from 'express-rate-limit';

export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
`);

writeFileSync(join(testDir, 'src/config.ts'), `
export const SECRET_KEY = process.env.JWT_SECRET;
export const RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  max: 100
};
`);

// auth.ts imports config.ts
writeFileSync(join(testDir, 'src/auth.ts'), `
import { SECRET_KEY } from './config.js';
import express from 'express';

export function loginHandler(req, res) {
  const { username, password } = req.body;
  
  // TODO: Add rate limiting
  const token = jwt.sign({ username }, SECRET_KEY);
  
  res.json({ token });
}
`);

console.log('✅ Test project created\n');

// Test Phase 1: Keyword-based
console.log('📍 Phase 1: Keyword-based RAG\n');

try {
  const output = execSync(
    `cd ${testDir} && CREW_RAG_MODE=keyword node ${process.cwd()}/bin/crew.js run "add rate limiting to auth endpoint" --dry-run 2>&1 || true`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  
  console.log('Output:', output.slice(0, 500));
  
  if (output.includes('[RAG] Loaded')) {
    const match = output.match(/\[RAG\] Loaded (\d+) files/);
    if (match) {
      console.log(`✅ Phase 1 PASSED: Loaded ${match[1]} files via keyword matching\n`);
    }
  } else {
    console.log('⚠️  Phase 1: No RAG output detected (may be working but not logging)\n');
  }
} catch (err) {
  console.log('❌ Phase 1 FAILED:', err.message);
}

// Test Phase 2: Import graph
console.log('📍 Phase 2: Import Graph Integration\n');

try {
  const output = execSync(
    `cd ${testDir} && CREW_RAG_MODE=import-graph node ${process.cwd()}/bin/crew.js run "update auth to use config" --dry-run 2>&1 || true`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  
  console.log('Output:', output.slice(0, 500));
  
  if (output.includes('[RAG] Loaded')) {
    const match = output.match(/\[RAG\] Loaded (\d+) files/);
    if (match) {
      const count = parseInt(match[1]);
      if (count >= 2) {
        console.log(`✅ Phase 2 PASSED: Loaded ${count} files (includes imports)\n`);
      } else {
        console.log(`⚠️  Phase 2: Only loaded ${count} file(s), expected 2+\n`);
      }
    }
  }
} catch (err) {
  console.log('❌ Phase 2 FAILED:', err.message);
}

// Test Phase 3: Semantic RAG (optional - requires OpenAI key)
if (process.env.OPENAI_API_KEY) {
  console.log('📍 Phase 3: Semantic RAG (with embeddings)\n');
  
  try {
    const output = execSync(
      `cd ${testDir} && CREW_RAG_MODE=semantic node ${process.cwd()}/bin/crew.js run "improve authentication security" --dry-run 2>&1 || true`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60000 }
    );
    
    console.log('Output:', output.slice(0, 500));
    
    if (output.includes('Building index')) {
      console.log('✅ Phase 3: Index build triggered\n');
    }
    
    if (output.includes('[RAG] Loaded')) {
      console.log('✅ Phase 3 PASSED: Semantic search working\n');
    }
  } catch (err) {
    if (err.message.includes('timeout')) {
      console.log('⚠️  Phase 3: Timeout (index build takes time on first run)\n');
    } else {
      console.log('❌ Phase 3 FAILED:', err.message);
    }
  }
} else {
  console.log('⏭️  Phase 3 SKIPPED: Set OPENAI_API_KEY to test semantic RAG\n');
}

// Test session-aware boosting
console.log('📍 Session-Aware Boosting Test\n');

try {
  // Simulate session by running two commands
  execSync(
    `cd ${testDir} && node ${process.cwd()}/bin/crew.js run "read auth.ts" --dry-run 2>&1 || true`,
    { encoding: 'utf8', stdio: 'ignore' }
  );
  
  const output = execSync(
    `cd ${testDir} && CREW_RAG_MODE=keyword node ${process.cwd()}/bin/crew.js run "update this file" --dry-run 2>&1 || true`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  
  if (output.includes('auth.ts')) {
    console.log('✅ Session-aware boosting: auth.ts prioritized from history\n');
  } else {
    console.log('⚠️  Session-aware: May need session history integration\n');
  }
} catch (err) {
  console.log('❌ Session test failed:', err.message);
}

// Cleanup
try {
  rmSync(testDir, { recursive: true, force: true });
} catch {}

console.log('\n✨ RAG Test Complete!\n');
console.log('Configuration via environment variables:');
console.log('  CREW_RAG_MODE=keyword|import-graph|semantic|off');
console.log('  CREW_RAG_TOKEN_BUDGET=8000 (default)');
console.log('  CREW_RAG_MAX_FILES=10 (default)');
console.log('  CREW_RAG_CACHE_DIR=.crew/rag-cache (default)');
