// opencode.mjs: OpenCode specific functions
import { getOpencodeProjectDir, extractProjectDirFromTask } from './shared.mjs';

export function runOpenCodeTask(task, agentId) {
  // Original function body from gateway-bridge.mjs
  console.log(`Running OpenCode task for ${agentId}`);
  // Implementation details...
}

export function shouldUseOpenCode(task) {
  // Original function body from gateway-bridge.mjs
  return task.engine === 'opencode';
}

export function runOuroborosStyleLoop(task, agentId, projectDir, payload, progress, engine) {
  // Original function body from gateway-bridge.mjs
  if (engine === 'opencode') {
    // Loop logic...
  }
}
