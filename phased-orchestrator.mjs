#!/usr/bin/env node
/**
 * ⚠️  DEPRECATED — phased-orchestrator.mjs is no longer maintained
 *
 * Use pm-loop.mjs instead:
 *   node pm-loop.mjs --project-dir /path/to/project
 *
 * PM loop has all the features phased-orchestrator had plus:
 * - Self-extending roadmap
 * - Better error recovery
 * - Configurable agent routing
 * - Real-time progress tracking
 *
 * If you need phased execution without self-extend:
 *   PM_SELF_EXTEND=0 node pm-loop.mjs
 */

console.error('\n⚠️  phased-orchestrator.mjs is DEPRECATED');
console.error('\nUse pm-loop.mjs instead:');
console.error('  node pm-loop.mjs --project-dir /path/to/project');
console.error('\nFor phased execution without self-extend:');
console.error('  PM_SELF_EXTEND=0 node pm-loop.mjs\n');
process.exit(1);
