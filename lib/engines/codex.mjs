// codex.mjs: Codex specific functions
export function runCodexTask(task, agentId) {
  // Original function body from gateway-bridge.mjs
  console.log(`Running Codex task for ${agentId}`);
  // Implementation details...
}

export function shouldUseCodex(task) {
  // Original function body from gateway-bridge.mjs
  return task.engine === 'codex';
}
