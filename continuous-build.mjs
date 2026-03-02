#!/usr/bin/env node
/**
 * ⚠️  DEPRECATED — continuous-build.mjs is no longer maintained
 *
 * Use pm-loop.mjs instead:
 *   node pm-loop.mjs --project-dir /path/to/project
 *
 * PM loop has all the features continuous-build had plus:
 * - Self-extending roadmap
 * - Better error recovery
 * - Configurable agent routing
 * - Real-time progress tracking
 *
 * If you need to build until roadmap is empty (no self-extend):
 *   PM_SELF_EXTEND=0 node pm-loop.mjs
 */

console.error('\n⚠️  continuous-build.mjs is DEPRECATED');
console.error('\nUse pm-loop.mjs instead:');
console.error('  node pm-loop.mjs --project-dir /path/to/project');
console.error('\nTo build until roadmap is empty (no self-extend):');
console.error('  PM_SELF_EXTEND=0 node pm-loop.mjs\n');
process.exit(1);
