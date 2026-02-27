// Modified gateway-bridge.mjs: Imports added, functions extracted
import { runOpenCodeTask, shouldUseOpenCode, runOuroborosStyleLoop } from './lib/engines/opencode.mjs';
import { runClaudeCodeTask, shouldUseClaudeCode } from './lib/engines/claude-code.mjs';
import { runCursorCliTask, shouldUseCursorCli } from './lib/engines/cursor-cli.mjs';
import { runCodexTask, shouldUseCodex } from './lib/engines/codex.mjs';
import { runDockerSandboxTask, shouldUseDockerSandbox } from './lib/engines/docker-sandbox.mjs';
// Assume original file content with extracted functions replaced
// Original content here, with comments for extracted parts
// ... [rest of the file, e.g., other code not related to engines] ...

// // moved to lib/engines/opencode.mjs
// function runOpenCodeTask() { ... }  // Removed

// // moved to lib/engines/claude-code.mjs
// function runClaudeCodeTask() { ... }  // Removed

// Etc. for other functions
