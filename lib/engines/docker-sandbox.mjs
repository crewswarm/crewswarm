// docker-sandbox.mjs: Docker Sandbox specific functions
export function runDockerSandboxTask(task, agentId) {
  // Original function body from gateway-bridge.mjs
  console.log(`Running Docker Sandbox task for ${agentId}`);
  // Implementation details...
}

export function shouldUseDockerSandbox(task) {
  // Original function body from gateway-bridge.mjs
  return task.engine === 'docker-sandbox';
}
