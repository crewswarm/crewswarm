import { startRepl, type ReplOptions } from '../repl/index.js';

/**
 * TUI adapter.
 * Reuses the same REPL runtime/controller so routing, orchestration,
 * sandbox, memory, and safety behavior stay in one code path.
 */
export async function startTui(options: ReplOptions): Promise<void> {
  process.env.CREW_UI_MODE = 'tui';
  await startRepl({
    ...options,
    uiMode: 'tui'
  });
}
