/**
 * crew-cli Sandbox Integration for gateway-bridge
 * 
 * This engine properly integrates crew-cli's 3-tier architecture:
 * 1. Spawn crew-cli (L1 Router → L2 Planner → L3 Workers)
 * 2. crew-cli stages changes in .crew/sandbox.json
 * 3. Gateway reads sandbox and applies changes to disk
 * 4. Return summary of applied files
 * 
 * This preserves crew-cli's safety gates (blast radius, validation)
 * while still providing synchronous results for multi-agent orchestration.
 */

import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { constants } from 'fs';

const DEBUG = Boolean(process.env.CREWSWARM_DEBUG || process.env.DEBUG);

/**
 * Normalize crewswarm model format to crew-cli format.
 * crewswarm: "provider/model-name" (e.g., "groq/llama-3.3-70b-versatile")
 * crew-cli: just "model-name" + provider API key in env
 * 
 * @param {string} model - Model in "provider/model" format
 * @returns {Object} { executionModel, routerModel, apiKeyEnv }
 */
function normalizeCrewCliModel(model) {
  if (!model || typeof model !== 'string') {
    return { executionModel: null, routerModel: null, apiKeyEnv: {} };
  }

  // Parse provider/model format
  const [provider, modelName] = model.includes('/') 
    ? model.split('/', 2) 
    : [null, model];

  // Map provider to crew-cli env var names
  const providerMap = {
    'groq': { key: 'GROQ_API_KEY', routerModel: 'llama-3.3-70b-versatile' },
    'xai': { key: 'XAI_API_KEY', routerModel: 'grok-4-1-fast-reasoning' },
    'google': { key: 'GOOGLE_API_KEY', routerModel: 'gemini-2.5-flash' },
    'gemini': { key: 'GEMINI_API_KEY', routerModel: 'gemini-2.5-flash' },
    'anthropic': { key: 'ANTHROPIC_API_KEY', routerModel: 'claude-sonnet-4' },
    'deepseek': { key: 'DEEPSEEK_API_KEY', routerModel: 'deepseek-chat' },
    'openai': { key: 'OPENAI_API_KEY', routerModel: 'gpt-4o' },
    'mistral': { key: 'MISTRAL_API_KEY', routerModel: 'mistral-large-latest' },
  };

  const providerConfig = provider ? providerMap[provider.toLowerCase()] : null;
  
  return {
    executionModel: modelName || model,
    routerModel: providerConfig?.routerModel || modelName || model,
    apiKeyEnv: providerConfig?.key || null
  };
}

/**
 * Inject API keys from crewswarm config into crew-cli environment
 * Reads from ~/.crewswarm/crewswarm.json → providers.{name}.apiKey
 * 
 * @param {Object} env - Environment object to modify
 * @param {string|null} primaryKeyName - Primary API key env var (e.g., "GROQ_API_KEY")
 */
async function injectApiKeysToEnv(env, primaryKeyName) {
  try {
    const { readFile } = await import('fs/promises');
    const { homedir } = await import('os');
    const configPath = `${homedir()}/.crewswarm/crewswarm.json`;
    
    const configData = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configData);
    const providers = config.providers || {};
    
    // Map crewswarm provider names to crew-cli env var names
    const keyMap = {
      'groq': 'GROQ_API_KEY',
      'xai': 'XAI_API_KEY',
      'google': 'GOOGLE_API_KEY',
      'gemini': 'GEMINI_API_KEY',
      'anthropic': 'ANTHROPIC_API_KEY',
      'deepseek': 'DEEPSEEK_API_KEY',
      'openai': 'OPENAI_API_KEY',
      'mistral': 'MISTRAL_API_KEY',
    };
    
    // Inject all available API keys (crew-cli may need fallbacks)
    for (const [providerName, envVarName] of Object.entries(keyMap)) {
      const providerConfig = providers[providerName];
      if (providerConfig && providerConfig.apiKey) {
        env[envVarName] = providerConfig.apiKey;
        if (DEBUG) {
          console.error(`[crew-cli-sandbox] Injected ${envVarName}`);
        }
      }
    }
    
    // Ensure primary key is set (if specified and found)
    if (primaryKeyName && !env[primaryKeyName]) {
      console.warn(`[crew-cli-sandbox] Primary API key ${primaryKeyName} not found in crewswarm config`);
    }
    
  } catch (err) {
    console.error('[crew-cli-sandbox] Failed to inject API keys:', err.message);
    // Non-fatal - crew-cli might already have keys in env
  }
}

/**
 * Sandbox state format (from crew-cli/src/sandbox/index.ts)
 * 
 * @typedef {Object} SandboxChange
 * @property {string} path
 * @property {string} original
 * @property {string} modified
 * @property {string} timestamp
 * 
 * @typedef {Object} SandboxState
 * @property {string} updatedAt
 * @property {string} activeBranch
 * @property {Object<string, Object<string, SandboxChange>>} branches
 */

/**
 * Run a task via crew-cli and auto-apply sandbox changes
 * 
 * Signature matches other engines: (prompt, payload)
 * where prompt is the first arg (not inside payload)
 */
export async function runCrewCLIWithSandbox(prompt, payload = {}) {
  console.error('[crew-cli-sandbox] 🚀 FUNCTION CALLED 🚀');
  
  const {
    projectDir = process.cwd(),
    model,
    agentId,
    sessionId
  } = payload;

  if (!prompt) {
    throw new Error('crew-cli-sandbox: prompt is required');
  }

  if (DEBUG) {
    console.error('[crew-cli-sandbox] Starting task:', {
      agent: agentId,
      projectDir,
      model: model || '(default)',
      promptLength: prompt.length
    });
  }

  // Step 1: Spawn crew-cli to stage changes in sandbox
  const { exitCode, stdout, stderr } = await spawnCrewCLI(prompt, projectDir, model);

  if (DEBUG) {
    console.error('[crew-cli-sandbox] crew-cli exited:', {
      code: exitCode,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length
    });
  }

  // Step 2: Parse JSON response
  let crewResult;
  try {
    // crew-cli may emit logs before JSON — find the JSON object
    // Match any kind (chat.result, run.result, etc.)
    const jsonMatch = stdout.match(/\{[\s\S]*"kind":\s*"[^"]+\.result"[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[crew-cli-sandbox] crew-cli exited:', { code: exitCode, stdoutLen: stdout.length, stderrLen: stderr.length });
      console.error('[crew-cli-sandbox] stdout:', stdout.substring(0, 500));
      console.error('[crew-cli-sandbox] stderr:', stderr.substring(0, 500));
      throw new Error('No result JSON found in output');
    }
    crewResult = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[crew-cli-sandbox] Failed to parse crew-cli JSON output');
    console.error('[crew-cli-sandbox] stdout:', stdout.substring(0, 500));
    console.error('[crew-cli-sandbox] stderr:', stderr.substring(0, 500));
    throw new Error(`crew-cli returned non-JSON output: ${err.message}`);
  }

  // crew-cli uses phase/kind - accept both chat.result and run.result
  const isSuccess = (crewResult.kind === 'run.result' || crewResult.kind === 'chat.result') && 
                    (!crewResult.phase || crewResult.phase === 'complete');
  if (!isSuccess) {
    console.error('[crew-cli-sandbox] Task not successful:', { kind: crewResult.kind, phase: crewResult.phase });
    throw new Error(`crew-cli task failed: phase=${crewResult.phase}, kind=${crewResult.kind}`);
  }
  
  console.error('[crew-cli-sandbox] ✅ Task completed successfully');
  console.error('[crew-cli-sandbox] crewResult keys:', Object.keys(crewResult));
  console.error('[crew-cli-sandbox] crewResult.response:', crewResult.response?.substring(0, 200));

  // Step 3: Read sandbox state
  const sandboxPath = join(projectDir, '.crew', 'sandbox.json');
  const sandboxState = await readSandboxState(sandboxPath);
  console.error('[crew-cli-sandbox] Sandbox state:', sandboxState ? `found (${Object.keys(sandboxState.branches || {}).length} branches)` : 'not found');

  if (!sandboxState || !sandboxState.branches) {
    if (DEBUG) {
      console.error('[crew-cli-sandbox] No sandbox state found - task may not have made file changes');
    }
    // Return string directly for rt-envelope
    return crewResult.response || stdout;
  }

  // Step 4: Get pending changes from active branch
  const activeBranch = sandboxState.activeBranch || 'main';
  const pendingChanges = sandboxState.branches[activeBranch] || {};
  const changedPaths = Object.keys(pendingChanges);

  if (changedPaths.length === 0) {
    if (DEBUG) {
      console.error('[crew-cli-sandbox] No pending changes in sandbox');
    }
    // Return string directly for rt-envelope
    return crewResult.response || stdout;
  }

  if (DEBUG) {
    console.error('[crew-cli-sandbox] Pending changes:', changedPaths);
  }

  // Step 5: Apply sandbox changes to disk
  const appliedFiles = await applySandboxChanges(pendingChanges, projectDir);

  if (DEBUG) {
    console.error('[crew-cli-sandbox] Applied files:', appliedFiles);
  }

  // Step 6: Clear sandbox (like crew apply does)
  await clearSandboxBranch(sandboxPath, activeBranch);

  // Step 7: Return result with file summary
  // NOTE: rt-envelope expects a STRING response, not an object
  const responseText = formatResponseWithFiles(crewResult.response || stdout, appliedFiles);
  
  console.error('[crew-cli-sandbox] Returning response:', {
    responseLength: responseText?.length || 0,
    appliedFilesCount: appliedFiles.length,
    crewResultResponse: crewResult.response?.substring(0, 100)
  });
  
  return responseText; // Return string directly, not object
}

/**
 * Spawn crew-cli binary
 */
async function spawnCrewCLI(prompt, projectDir, model) {
  // Validate cwd exists — spawn throws ENOENT if the directory doesn't exist
  const { existsSync } = await import('fs');
  const safeCwd = (projectDir && existsSync(projectDir)) ? projectDir : process.cwd();
  
  console.error('[crew-cli-sandbox] ✨ USING SANDBOX RUNNER WITH FIXED STDIN ✨');
  
  return new Promise(async (resolve, reject) => {
    // Find crew binary (try both local and global)
    const crewBin = process.env.CREW_CLI_BIN || 'crew';

    const args = ['run', '-t', prompt, '--json'];

    // Normalize model format
    const { executionModel, routerModel, apiKeyEnv } = normalizeCrewCliModel(model);

    // crew-cli reads model AND API keys from env, not CLI flag
    const env = { ...process.env };
    if (executionModel) {
      env.CREW_EXECUTION_MODEL = executionModel;
    }
    if (routerModel) {
      env.CREW_ROUTING_MODEL = routerModel; // For orchestrator routing decisions
    }
    
    // Pass API keys from crewswarm config to crew-cli env
    // crew-cli expects: GROQ_API_KEY, XAI_API_KEY, GEMINI_API_KEY, etc.
    await injectApiKeysToEnv(env, apiKeyEnv);
    
    // Force standalone mode — prevent crew-cli from routing back to gateway
    env.CREW_INTERFACE_MODE = 'standalone';
    if (safeCwd !== projectDir) {
      console.warn(`[crew-cli-sandbox] projectDir "${projectDir}" does not exist, using cwd: ${safeCwd}`);
    }

    // ALWAYS log model info (not behind DEBUG flag)
    console.error('[crew-cli-sandbox] ═══════════════════════════════════════');
    console.error('[crew-cli-sandbox] Spawning:', crewBin, args.join(' '));
    console.error('[crew-cli-sandbox] CWD:', safeCwd);
    console.error('[crew-cli-sandbox] Model (raw):', model || '(none provided)');
    console.error('[crew-cli-sandbox] Model (execution):', executionModel || '(default)');
    console.error('[crew-cli-sandbox] Model (router):', routerModel || '(default)');
    console.error('[crew-cli-sandbox] Env CREW_EXECUTION_MODEL:', env.CREW_EXECUTION_MODEL || '(not set)');
    console.error('[crew-cli-sandbox] Env CREW_ROUTING_MODEL:', env.CREW_ROUTING_MODEL || '(not set)');
    console.error('[crew-cli-sandbox] Env GROQ_API_KEY:', env.GROQ_API_KEY ? 'SET' : 'NOT SET');
    console.error('[crew-cli-sandbox] Env ANTHROPIC_API_KEY:', env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');
    console.error('[crew-cli-sandbox] ═══════════════════════════════════════');

    const child = spawn(crewBin, args, {
      cwd: safeCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']  // Close stdin — crew-cli doesn't need it
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (DEBUG) {
        process.stderr.write(chunk); // Pass through crew-cli's debug output
      }
    });

    child.on('error', (err) => {
      console.error('[crew-cli-sandbox] spawn error:', err.message);
      reject(new Error(`Failed to spawn crew-cli: ${err.message}`));
    });

    child.on('close', (code) => {
      console.error('[crew-cli-sandbox] child closed:', { code, stdoutLen: stdout.length, stderrLen: stderr.length });
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * Read sandbox state from .crew/sandbox.json
 */
async function readSandboxState(sandboxPath) {
  try {
    await access(sandboxPath, constants.F_OK);
  } catch {
    return null; // Sandbox file doesn't exist
  }

  try {
    const raw = await readFile(sandboxPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[crew-cli-sandbox] Failed to parse sandbox: ${err.message}`);
    return null;
  }
}

/**
 * Apply staged changes from sandbox to actual files
 */
async function applySandboxChanges(pendingChanges, projectDir) {
  const appliedFiles = [];

  for (const [relativePath, change] of Object.entries(pendingChanges)) {
    const fullPath = join(projectDir, relativePath);
    const dir = dirname(fullPath);

    try {
      // Create directory if needed
      try {
        await access(dir, constants.F_OK);
      } catch {
        await mkdir(dir, { recursive: true });
      }

      // Write file
      await writeFile(fullPath, change.modified, 'utf8');
      appliedFiles.push(relativePath);

      if (DEBUG) {
        console.error(`[crew-cli-sandbox] ✅ Wrote ${relativePath} (${change.modified.length} bytes)`);
      }
    } catch (err) {
      console.error(`[crew-cli-sandbox] ❌ Failed to write ${relativePath}: ${err.message}`);
      // Continue with other files
    }
  }

  return appliedFiles;
}

/**
 * Clear sandbox branch after applying (like crew apply does)
 */
async function clearSandboxBranch(sandboxPath, branchName) {
  try {
    const state = await readSandboxState(sandboxPath);
    if (!state || !state.branches || !state.branches[branchName]) {
      return; // Nothing to clear
    }

    // Clear the branch
    state.branches[branchName] = {};
    state.updatedAt = new Date().toISOString();

    await writeFile(sandboxPath, JSON.stringify(state, null, 2), 'utf8');

    if (DEBUG) {
      console.error(`[crew-cli-sandbox] Cleared sandbox branch: ${branchName}`);
    }
  } catch (err) {
    console.error(`[crew-cli-sandbox] Warning: failed to clear sandbox: ${err.message}`);
    // Non-fatal - the task succeeded
  }
}

/**
 * Format response to include file summary
 */
function formatResponseWithFiles(response, appliedFiles) {
  if (appliedFiles.length === 0) {
    return response;
  }

  const fileList = appliedFiles.map(f => `  - ${f}`).join('\n');
  return `${response}\n\n**Files modified (${appliedFiles.length}):**\n${fileList}`;
}
