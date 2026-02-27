// shared.mjs: Shared helpers for engine modules
export function getOpencodeProjectDir() {
  // Original function body from gateway-bridge.mjs
  return process.env.OPENCODE_PROJECT_DIR || '/default/path';
}

export function extractProjectDirFromTask(task) {
  // Original function body from gateway-bridge.mjs
  return task.projectDir || process.cwd();
}

export function buildMiniTaskForOpenCode(task) {
  // Original function body from gateway-bridge.mjs
  return { ...task, simplified: true };
}

export function getAgentOpenCodeConfig(agentId) {
  // Original function body from gateway-bridge.mjs
  return { model: 'default-model', maxRounds: 10 };
}
