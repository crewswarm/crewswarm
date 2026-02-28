/**
 * REFACTOR PLAN: Dynamic Engine Registry
 * 
 * This file documents how to migrate from hardcoded shouldUse*() functions
 * to a dynamic engine registry with priority-based routing.
 */

// ═══════════════════════════════════════════════════════════════════════════
// CURRENT ARCHITECTURE (Hardcoded, Brittle)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BEFORE: Each engine manually checks all higher-priority engines
 */

// lib/engines/runners.mjs
export function shouldUseCursorCli(payload, incomingType) {
  // Priority 100 (highest) - no checks needed
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  const runtime = String(payload?.runtime || payload?.executor || "").toLowerCase();
  if (runtime === "cursor" || runtime === "cursor-cli") return true;
  if (payload?.useCursorCli === true) return true;
  // ... agent config check ...
}

export function shouldUseClaudeCode(payload, incomingType) {
  // Priority 90
  if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
  if (shouldUseCursorCli(payload, incomingType)) return false; // ❌ Manual check
  // ... rest of logic ...
}

export function shouldUseOpenCode(payload, prompt, incomingType) {
  // Priority 20
  if (!CREWSWARM_OPENCODE_ENABLED) return false;
  if (shouldUseCursorCli(payload, incomingType)) return false; // ❌ Manual check
  if (shouldUseClaudeCode(payload, incomingType)) return false; // ❌ Manual check
  // Missing: Codex, Docker, Gemini checks!
  // ... rest of logic ...
}

/**
 * PROBLEM: Adding Codex means updating:
 * 1. shouldUseOpenCode() - add if (shouldUseCodex(...)) return false;
 * 2. shouldUseGeminiCli() - add if (shouldUseCodex(...)) return false;
 * 3. rt-envelope.mjs - add !useCodex to Gemini/Generic/OpenCode conditions
 * 4. Engine execution branches - add else if (useCodex) { ... }
 * 
 * This is O(n²) complexity: n engines × n cross-checks
 */

// ═══════════════════════════════════════════════════════════════════════════
// NEW ARCHITECTURE (Dynamic, Extensible)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AFTER: Register engines with priority, automatic conflict resolution
 */

// lib/engines/cursor-cli-engine.mjs
import { registerEngine, runtimeMatches, agentHasEngine } from "./engine-registry.mjs";
import { runCursorCliTask } from "./runners.mjs";

registerEngine({
  id: "cursor-cli",
  priority: 100, // Highest
  label: "Cursor CLI",
  telemetryKey: "realtime_route_cursor_cli",
  
  shouldUse(payload, incomingType, ctx) {
    // No need to check other engines - we're highest priority!
    if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
    if (runtimeMatches(payload, "cursor", "cursor-cli")) return true;
    if (payload?.useCursorCli === true) return true;
    
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    if (agentId === "crew-orchestrator" || agentId === "orchestrator") {
      const ocCfg = getAgentOpenCodeConfig(agentId);
      if (ocCfg.useCursorCli === true) return true;
      return process.env.CREWSWARM_CURSOR_WAVES === "1";
    }
    
    return agentHasEngine(agentId, "useCursorCli", loadAgentList);
  },
  
  run: runCursorCliTask,
});

// lib/engines/claude-code-engine.mjs
import { registerEngine, runtimeMatches, agentHasEngine, getGlobalFlag } from "./engine-registry.mjs";
import { runClaudeCodeTask } from "./runners.mjs";

registerEngine({
  id: "claude-code",
  priority: 90,
  label: "Claude Code",
  telemetryKey: "realtime_route_claude_code",
  
  shouldUse(payload, incomingType, ctx) {
    // No manual checks - registry handles priority!
    // ctx.higherPriorityEngines = ["cursor-cli"] (set automatically by registry)
    if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
    if (runtimeMatches(payload, "claude", "claude-code")) return true;
    if (payload?.useClaudeCode === true) return true;
    
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    if (agentHasEngine(agentId, "useClaudeCode", loadAgentList)) return true;
    
    return getGlobalFlag("claudeCode") || process.env.CREWSWARM_CLAUDE_CODE === "1";
  },
  
  run: runClaudeCodeTask,
});

// lib/engines/codex-engine.mjs
import { registerEngine, runtimeMatches, agentHasEngine } from "./engine-registry.mjs";
import { runCodexTask } from "./runners.mjs";

registerEngine({
  id: "codex",
  priority: 80,
  label: "Codex CLI",
  telemetryKey: "realtime_route_codex",
  
  shouldUse(payload, incomingType, ctx) {
    // ✅ No manual checks needed!
    // ctx.higherPriorityEngines = ["cursor-cli", "claude-code"]
    if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
    if (runtimeMatches(payload, "codex", "codex-cli")) return true;
    if (payload?.useCodex === true) return true;
    
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    if (agentHasEngine(agentId, "useCodex", loadAgentList)) return true;
    
    return process.env.CREWSWARM_CODEX === "1";
  },
  
  run: runCodexTask,
});

// lib/engines/opencode-engine.mjs
import { registerEngine, runtimeMatches, agentHasEngine } from "./engine-registry.mjs";
import { runOpenCodeTask } from "./runners.mjs";

registerEngine({
  id: "opencode",
  priority: 20, // Low priority (fallback)
  label: "OpenCode",
  telemetryKey: "realtime_route_opencode",
  
  shouldUse(payload, prompt, incomingType, ctx) {
    // ✅ No manual checks - all higher-priority engines checked automatically!
    // ctx.higherPriorityEngines = ["cursor-cli", "claude-code", "codex", "docker-sandbox", "gemini-cli", "generic-engines"]
    
    if (process.env.CREWSWARM_OPENCODE_ENABLED !== "1") return false;
    if (process.env.CREWSWARM_OPENCODE_FORCE === "1") return true;
    if (incomingType !== "command.run_task" && incomingType !== "task.assigned") return false;
    if (runtimeMatches(payload, "opencode", "gpt5", "gpt-5")) return true;
    if (payload?.useOpenCode === true) return true;
    
    const agentId = String(payload?.agentId || payload?.agent || "").toLowerCase();
    const ocCfg = getAgentOpenCodeConfig(agentId);
    return ocCfg.enabled;
  },
  
  run: runOpenCodeTask,
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTING SIMPLIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BEFORE (lib/engines/rt-envelope.mjs):
 */
const useCursorCli = shouldUseCursorCli(payload, incomingType);
const useClaudeCode = shouldUseClaudeCode(payload, incomingType);
const useCodex = shouldUseCodex(payload, incomingType);
const useDockerSandbox = shouldUseDockerSandbox(payload, incomingType);
const useGeminiCli = !useCursorCli && !useClaudeCode && !useCodex && !useDockerSandbox && shouldUseGeminiCli(payload, incomingType);
const _genericEngines = (!useCursorCli && !useClaudeCode && !useCodex && !useDockerSandbox && !useGeminiCli)
  ? (loadGenericEngines?.() || []) : [];
const genericEngineMatch = _genericEngines.find(eng => shouldUseGenericEngine(eng, payload, incomingType)) || null;
const useOpenCode = !useCodex && !useDockerSandbox && !useGeminiCli && !genericEngineMatch && shouldUseOpenCode(payload, prompt, incomingType);

if (useCursorCli) {
  progress(`Routing to Cursor CLI...`);
  reply = await runCursorCliTask(...);
} else if (useClaudeCode) {
  progress(`Routing to Claude Code...`);
  reply = await runClaudeCodeTask(...);
} else if (useCodex) {
  progress(`Routing to Codex...`);
  reply = await runCodexTask(...);
} // ... 5 more else-if branches

/**
 * AFTER:
 */
import { selectEngine } from "./engine-registry.mjs";

const engine = selectEngine(payload, incomingType, { prompt });

if (engine) {
  progress(`Routing to ${engine.label}...`);
  telemetry(engine.telemetryKey, { taskId, incomingType, from, agent: CREWSWARM_RT_AGENT });
  reply = await engine.run(prompt, payload);
} else {
  // Fallback to direct LLM call
  reply = await callLLMDirect(...);
}

// ═══════════════════════════════════════════════════════════════════════════
// BENEFITS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 1. ✅ O(n) complexity instead of O(n²)
 *    - Registry automatically skips lower-priority engines once one matches
 *    - No manual cross-checks needed
 * 
 * 2. ✅ Easy to add new engines
 *    - Create new file: lib/engines/codex-engine.mjs
 *    - Call registerEngine() with priority
 *    - Done! No changes to other engines needed
 * 
 * 3. ✅ Dynamic priority adjustment
 *    - Can change engine priority at runtime
 *    - Can disable/enable engines without code changes
 * 
 * 4. ✅ Better testability
 *    - Each engine's shouldUse() is independent
 *    - Can test engine selection without mocking all other engines
 * 
 * 5. ✅ Clear priority documentation
 *    - listEngines() shows priority order
 *    - No need to trace through nested if statements
 */

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION STEPS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase 1: Create registry (✅ DONE - see lib/engines/engine-registry.mjs)
 * Phase 2: Register existing engines without changing behavior
 *   - cursor-cli-engine.mjs (priority 100)
 *   - claude-code-engine.mjs (priority 90)
 *   - codex-engine.mjs (priority 80)
 *   - docker-sandbox-engine.mjs (priority 70)
 *   - gemini-cli-engine.mjs (priority 60)
 *   - generic-engine.mjs (priority 30)
 *   - opencode-engine.mjs (priority 20)
 * Phase 3: Update rt-envelope.mjs to use selectEngine()
 * Phase 4: Remove old shouldUse*() functions from runners.mjs
 * Phase 5: Update tests
 */

// ═══════════════════════════════════════════════════════════════════════════
// PRIORITY GUIDE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 100 - Cursor CLI (highest - orchestrator coordination)
 * 90  - Claude Code (premium code generation)
 * 80  - Codex (GPT-5/local models)
 * 70  - Docker Sandbox (isolated execution)
 * 60  - Gemini CLI (Google AI)
 * 50  - (reserved for future engines)
 * 40  - (reserved for future engines)
 * 30  - Generic engines (drop-in binaries)
 * 20  - OpenCode (default fallback)
 * 10  - (reserved - could be used for "any available" fallback)
 * 0   - Direct LLM (no engine, pure API calls)
 */
