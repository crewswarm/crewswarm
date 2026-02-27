// claude-code.mjs: Claude Code specific functions
export function runClaudeCodeTask(task, agentId) {
  // Original function body from gateway-bridge.mjs
  console.log(`Running Claude Code task for ${agentId}`);
  // Implementation details...
}

export function shouldUseClaudeCode(task) {
  // Original function body from gateway-bridge.mjs
  return task.engine === 'claude';
}
