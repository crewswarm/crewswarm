/**
 * Engine API — public exports for use by gateway-bridge.
 * This is the entry point that lib/engines/crew-cli.mjs imports.
 * Provides direct function access to the agentic executor without spawning subprocesses.
 */
export { runAgenticWorker } from './executor/agentic-executor.js';
export { Sandbox } from './sandbox/index.js';
