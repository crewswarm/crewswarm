// cursor-cli.mjs: Cursor CLI specific functions
export function runCursorCliTask(task, agentId) {
  // Original function body from gateway-bridge.mjs
  console.log(`Running Cursor CLI task for ${agentId}`);
  // Implementation details...
}

export function shouldUseCursorCli(task) {
  // Original function body from gateway-bridge.mjs
  return task.engine === 'cursor';
}
