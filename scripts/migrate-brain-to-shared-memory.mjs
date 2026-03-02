#!/usr/bin/env node
/**
 * Migrate legacy brain.md files to shared memory (AgentKeeper + AgentMemory).
 * 
 * Reads brain.md entries from memory/ and project .crewswarm/ directories,
 * converts them to structured memory facts, and stores them in the unified
 * shared memory system used by CLI, Gateway, and all agents.
 * 
 * Usage:
 *   node scripts/migrate-brain-to-shared-memory.mjs
 *   node scripts/migrate-brain-to-shared-memory.mjs --dry-run
 *   node scripts/migrate-brain-to-shared-memory.mjs --project /path/to/project
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  migrateBrainToMemory,
  rememberFact,
  getMemoryStats,
  isSharedMemoryAvailable,
  initSharedMemory,
  CREW_MEMORY_DIR,
} from '../lib/memory/shared-adapter.mjs';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const projectArg = (() => {
  const idx = args.indexOf('--project');
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
})();

console.log('=== Brain.md → Shared Memory Migration ===\n');

// Check CLI modules
if (!isSharedMemoryAvailable()) {
  console.error('❌ Shared memory modules not available.');
  console.error('   Run: cd crew-cli && npm run build');
  process.exit(1);
}

// Initialize shared memory
const init = initSharedMemory();
if (!init.ok) {
  console.error(`❌ Failed to initialize shared memory: ${init.error}`);
  process.exit(1);
}
console.log(`✅ Shared memory directory: ${init.path}\n`);

if (isDryRun) {
  console.log('🔍 DRY RUN MODE — no writes will be performed\n');
}

// Migrate global brain.md
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const globalBrainPaths = [
  path.join(repoRoot, '.crewswarm', 'brain.md'),
  path.join(repoRoot, 'memory', 'brain.md'),
  path.join(repoRoot, 'crew-cli', '.crewswarm', 'brain.md'),
];

let globalBrainPath = null;
for (const p of globalBrainPaths) {
  if (fs.existsSync(p)) {
    globalBrainPath = p;
    break;
  }
}

if (globalBrainPath) {
  console.log(`📖 Migrating global brain.md: ${globalBrainPath}`);
  
  if (isDryRun) {
    const content = fs.readFileSync(globalBrainPath, 'utf8');
    const lines = content.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith('[') && t.length >= 10;
    });
    console.log(`   Would migrate ${lines.length} entries`);
    lines.slice(0, 5).forEach(l => console.log(`   - ${l.slice(0, 80)}...`));
  } else {
    const result = await migrateBrainToMemory(globalBrainPath, 'crew-lead');
    if (result.ok) {
      console.log(`   ✅ Imported ${result.imported} entries, skipped ${result.skipped}, errors ${result.errors}`);
    } else {
      console.log(`   ❌ Migration failed: ${result.error}`);
    }
  }
  console.log('');
} else {
  console.log('⚠️  Global brain.md not found (checked .crewswarm/brain.md, memory/brain.md)\n');
}

// Migrate lessons.md
const globalLessonsPaths = [
  path.join(repoRoot, '.crewswarm', 'lessons.md'),
  path.join(repoRoot, 'memory', 'lessons.md'),
  path.join(repoRoot, 'crew-cli', 'memory', 'lessons.md'),
];

let globalLessonsPath = null;
for (const p of globalLessonsPaths) {
  if (fs.existsSync(p)) {
    globalLessonsPath = p;
    break;
  }
}

if (globalLessonsPath) {
  console.log(`📖 Migrating lessons.md: ${globalLessonsPath}`);
  
  if (isDryRun) {
    const content = fs.readFileSync(globalLessonsPath, 'utf8');
    const lines = content.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith('[') && t.length >= 10;
    });
    console.log(`   Would migrate ${lines.length} entries`);
  } else {
    const result = await migrateBrainToMemory(globalLessonsPath, 'crew-lead');
    if (result.ok) {
      console.log(`   ✅ Imported ${result.imported} entries, skipped ${result.skipped}, errors ${result.errors}`);
    } else {
      console.log(`   ❌ Migration failed: ${result.error}`);
    }
  }
  console.log('');
} else {
  console.log('⚠️  lessons.md not found (checked .crewswarm/lessons.md, memory/lessons.md)\n');
}

// Find and migrate project-specific brain.md files
const findProjectBrains = () => {
  const projects = [];
  
  // Check registered projects from dashboard
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.crewswarm', 'crewswarm.json'), 'utf8'));
    if (cfg.projects) {
      for (const proj of cfg.projects) {
        if (proj.outputDir) {
          const brainPath = path.join(proj.outputDir, '.crewswarm', 'brain.md');
          if (fs.existsSync(brainPath)) {
            projects.push({ name: proj.name || proj.id, path: brainPath, id: proj.id });
          }
        }
      }
    }
  } catch {}
  
  // Check common project locations
  const desktopDir = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(desktopDir)) {
    try {
      for (const entry of fs.readdirSync(desktopDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const brainPath = path.join(desktopDir, entry.name, '.crewswarm', 'brain.md');
          if (fs.existsSync(brainPath) && !projects.some(p => p.path === brainPath)) {
            projects.push({ name: entry.name, path: brainPath, id: entry.name });
          }
        }
      }
    } catch {}
  }
  
  return projects;
};

// If --project specified, only migrate that one
if (projectArg) {
  const brainPath = path.join(projectArg, '.crewswarm', 'brain.md');
  if (fs.existsSync(brainPath)) {
    const projectName = path.basename(projectArg);
    console.log(`📖 Migrating project brain: ${projectName}`);
    
    if (!isDryRun) {
      const result = await migrateBrainToMemory(brainPath, `project-${projectName}`);
      if (result.ok) {
        console.log(`   ✅ Imported ${result.imported} entries, skipped ${result.skipped}, errors ${result.errors}`);
      } else {
        console.log(`   ❌ Migration failed: ${result.error}`);
      }
    }
  } else {
    console.log(`❌ Project brain not found: ${brainPath}`);
  }
} else {
  // Migrate all found projects
  const projectBrains = findProjectBrains();
  if (projectBrains.length > 0) {
    console.log(`📂 Found ${projectBrains.length} project brain(s):\n`);
    
    for (const proj of projectBrains) {
      console.log(`📖 Migrating ${proj.name}: ${proj.path}`);
      
      if (isDryRun) {
        const content = fs.readFileSync(proj.path, 'utf8');
        const lines = content.split('\n').filter(l => {
          const t = l.trim();
          return t && !t.startsWith('#') && !t.startsWith('[') && t.length >= 10;
        });
        console.log(`   Would migrate ${lines.length} entries`);
      } else {
        const result = await migrateBrainToMemory(proj.path, `project-${proj.id}`);
        if (result.ok) {
          console.log(`   ✅ Imported ${result.imported} entries, skipped ${result.skipped}, errors ${result.errors}`);
        } else {
          console.log(`   ❌ Migration failed: ${result.error}`);
        }
      }
      console.log('');
    }
  } else {
    console.log('ℹ️  No project brain.md files found\n');
  }
}

// Show final stats
if (!isDryRun) {
  console.log('=== Migration Complete ===\n');
  console.log('📊 Final Memory Statistics:\n');
  
  const stats = getMemoryStats('crew-lead');
  if (stats) {
    console.log(`AgentMemory (crew-lead):`);
    console.log(`  Total facts: ${stats.totalFacts}`);
    console.log(`  Critical facts: ${stats.criticalFacts}`);
    console.log(`  Providers: ${stats.providers.join(', ') || 'none'}`);
    console.log(`  Oldest fact: ${stats.oldestFact || 'N/A'}`);
    console.log(`  Newest fact: ${stats.newestFact || 'N/A'}`);
  }
  
  const { getKeeperStats } = await import('../lib/memory/shared-adapter.mjs');
  const keeperStats = await getKeeperStats(process.cwd());
  if (keeperStats) {
    console.log(`\nAgentKeeper:`);
    console.log(`  Total entries: ${keeperStats.entries}`);
    console.log(`  Storage: ${(keeperStats.bytes / 1024).toFixed(1)}KB`);
    console.log(`  By tier: ${Object.entries(keeperStats.byTier).map(([k,v]) => `${k}=${v}`).join(', ')}`);
    console.log(`  By agent: ${Object.entries(keeperStats.byAgent).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  }
  
  console.log(`\n💾 Shared memory storage: ${CREW_MEMORY_DIR}`);
  console.log('\n✅ All brain.md content is now available to CLI, Gateway, Cursor, and all agents.');
  console.log('   Set CREW_MEMORY_DIR in your .env to use a custom location.\n');
} else {
  console.log('\n=== Dry Run Complete ===');
  console.log('Run without --dry-run to perform the migration.\n');
}
