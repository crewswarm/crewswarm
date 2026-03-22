/**
 * Universal tool instruction builder for all agents
 * Teaches agents about BOTH direct tools and CLI tools, letting them choose intelligently
 */

/**
 * Build intelligent tool instructions for an agent
 * @param {Object} options
 * @param {string} options.agentId - Agent identifier (e.g., "crew-pm", "crew-coder")
 * @param {Object} options.permissions - { cli: boolean, dispatch: boolean, web: boolean }
 * @param {boolean} options.hasEngine - Whether agent has engine configured (OpenCode, Cursor, etc.)
 * @param {Object} options.agentConfig - Full agent config from crewswarm.json (optional, for engine preference)
 * @returns {string} Tool instructions to append to system prompt
 */
export function buildToolInstructions({
  agentId,
  permissions = {},
  hasEngine = false,
  agentConfig = null,
}) {
  const isPMAgent = agentId.includes("crew-pm");
  const isCoderAgent = [
    "crew-coder",
    "crew-coder-front",
    "crew-coder-back",
    "crew-fixer",
    "crew-frontend",
  ].includes(agentId);

  let instructions = `\n\n## Available Tools\n\nYou have access to multiple tool types. **Choose the right tool for the task:**\n`;

  // Direct/Local Tools - Available to ALL agents
  instructions += `\n### Direct Tools (fast, use for simple operations)
- **@@READ_FILE** /absolute/path — Read any file instantly
- **@@WRITE_FILE** /absolute/path — Write/update a file
  Content goes here
  **@@END_FILE**
- **@@MKDIR** /path/to/dir — Create directories
- **@@RUN_CMD** <command> — Execute shell commands

**Use direct tools when:**
- Reading a single file to check something
- Creating a NEW standalone file from scratch
- Running a quick shell command (ls, git status, etc.)
- Simple, isolated operations that DON'T modify existing code`;

  // CLI Tools - Only if agent has engine AND permissions
  if (permissions.cli && hasEngine) {
    // Determine preferred CLI from agent config
    const preferredCLI = getPreferredCLI(agentConfig);

    if (preferredCLI) {
      // Show only the preferred CLI (enforces global settings)
      const cliLabels = {
        "crew-cli": "TypeScript specialist (crew-cli)",
        opencode: "Full workspace context (OpenCode)",
        cursor: "Complex reasoning (Cursor)",
        claude: "Multi-file refactors (Claude Code)",
        codex: "OpenAI Codex",
        gemini: "Gemini CLI",
      };

      instructions += `\n\n### CLI Tools (powerful, use for complex operations)
- **@@CLI ${preferredCLI}** <task> — ${cliLabels[preferredCLI] || preferredCLI}

**Your preferred CLI is ${preferredCLI}.** Use this for all CLI operations.`;
    } else {
      // Show all CLIs if no preference (crew-cli first as recommended default)
      instructions += `\n\n### CLI Tools (powerful, use for complex operations)
- **@@CLI crew-cli** <task> — TypeScript specialist (recommended for most coding tasks)
- **@@CLI opencode** <task> — Full workspace context, multi-file editing
- **@@CLI cursor** <task> — Complex reasoning, deep analysis`;
    }

    instructions += `

**Use CLI tools when:**
- **MODIFYING existing code** (any file that already has logic)
- Editing multiple related files at once
- Need full workspace/codebase context
- Complex refactoring across files
- Need reasoning about architecture/structure
- Multi-step implementation with dependencies

**Example task routing:**
- "Create hello.txt with sample text" → Use **@@WRITE_FILE** (new file, no logic)
- "Modify auth.js to add error handling" → Use **@@CLI** (MODIFY existing code)
- "Update login function in auth.js" → Use **@@CLI** (MODIFY existing code)
- "Fix bug in auth.js" → Use **@@CLI** (MODIFY existing code)
- "Refactor auth system across 5 files" → Use **@@CLI** (complex)
- "Check what's in ROADMAP.md" → Use **@@READ_FILE** (just reading)
- "Create new ROADMAP.md with template" → Use **@@WRITE_FILE** (new file, simple content)
- "Update ROADMAP.md to mark item done" → Use **@@CLI** (MODIFY existing file)`;
  } else if (permissions.cli && !hasEngine) {
    instructions += `\n\n**Note:** CLI tools (@@CLI) are not configured for this agent. Use direct tools above for all file operations.`;
  }

  // Web Tools - with query classification hints
  if (permissions.web) {
    instructions += `\n\n### Web Research Tools
- **@@WEB_SEARCH** query — Search the web (Brave Search)
- **@@WEB_FETCH** https://url — Fetch and extract URL content

**ALWAYS use @@WEB_SEARCH when user asks about:**
- Latest/current/trending information (e.g., "latest design trends", "current best practices")
- News, events, or time-sensitive data
- Prices, reviews, recommendations
- Documentation or tutorials for external tools/libraries
- "What's new in..." or "Best ... in 2026" questions

**Use @@CLI only for:**
- Modifying existing code files in the workspace
- Creating new code with complex logic
- Multi-file implementations`;
  }

  // Dispatch/Delegation
  if (permissions.dispatch) {
    instructions += `\n\n### Delegation Tools
- **@@DISPATCH** agent-id task — Delegate to specialist agent

**Use when:** Task requires expertise outside your specialty (e.g., PM delegates coding to crew-coder)`;
  }

  // Agent-specific guidance
  if (isPMAgent) {
    instructions += `\n\n**As a PM agent:**
- Read roadmaps/PDDs with **@@READ_FILE** (fast)
- Write planning docs with **@@WRITE_FILE** (direct)
- Delegate implementation to coders with **@@DISPATCH** (proper routing)`;
  } else if (isCoderAgent) {
    instructions += `\n\n**As a coding agent:**
- **IMPORTANT:** ANY modification to existing code → **@@CLI** (proper validation)
- Creating NEW simple files (config, text, docs)? → **@@WRITE_FILE** (fast)
- Multi-file feature? → **@@CLI** (full context)
- Reading before editing? → **@@READ_FILE** first, then **@@CLI** to modify`;
  }

  // Tool execution note
  instructions += `\n\n**Tool execution:** When you emit a tool tag, it executes immediately and results are returned to you before your response reaches the user. Never fake results — always use the actual tool output.`;

  // Hard protocol guardrails: personality is allowed, tool syntax is not flexible
  instructions += `\n\n## Hard Protocol (non-negotiable)
- Personality/style is allowed in normal text, but **tool blocks must stay machine-clean**.
- **Never add jokes, slang, emojis, or commentary inside tool lines or file fences.**
- Tool line must be exact format, one per line: \`@@READ_FILE ...\`, \`@@WRITE_FILE ...\`, \`@@MKDIR ...\`, \`@@RUN_CMD ...\`, \`@@CLI ...\`, \`@@DISPATCH ...\`.
- For \`@@WRITE_FILE\`, output only file content between \`@@WRITE_FILE\` and \`@@END_FILE\` (no prose before \`@@END_FILE\`).
- If you need humor, put it outside tool blocks only.`;

  return instructions;
}

/**
 * Get preferred CLI from agent config (enforces global settings)
 * @param {Object} agentConfig - Agent config from crewswarm.json
 * @returns {string|null} - "crew-cli" | "opencode" | "cursor" | "claude" | "codex" | "gemini" | null
 */
export function getPreferredCLI(agentConfig) {
  if (!agentConfig) return null;

  // Priority order based on explicit flags
  if (agentConfig.useCrewCLI || agentConfig.engine === "crew-cli")
    return "crew-cli";
  if (agentConfig.useOpenCode || agentConfig.engine === "opencode")
    return "opencode";
  if (agentConfig.useCursorCli || agentConfig.engine === "cursor")
    return "cursor";
  if (agentConfig.useClaudeCode || agentConfig.engine === "claude")
    return "claude";
  if (agentConfig.useCodex || agentConfig.engine === "codex") return "codex";
  if (agentConfig.useGeminiCli || agentConfig.engine === "gemini")
    return "gemini";

  return null; // No preference - show all options
}

/**
 * Determine if agent has engine configured
 * @param {Object} agentConfig - Agent config from crewswarm.json
 * @returns {boolean}
 */
export function hasEngineConfigured(agentConfig) {
  if (!agentConfig) return false;

  return !!(
    agentConfig.useOpenCode ||
    agentConfig.useCursorCli ||
    agentConfig.useClaudeCode ||
    agentConfig.useCodex ||
    agentConfig.useGeminiCli ||
    agentConfig.useCrewCLI ||
    agentConfig.engine // generic engine field
  );
}

/**
 * Get tool permissions for agent
 * @param {string} agentId
 * @param {Object} agentConfig - Agent config from crewswarm.json
 * @returns {Object} { cli: boolean, dispatch: boolean, web: boolean }
 */
export function getToolPermissions(agentId, agentConfig) {
  // Check explicit permissions in config
  const crewswarmAllow = agentConfig?.tools?.crewswarmAllow || [];

  // Default permissions by agent type
  const defaults = {
    // PM agents: planning tools
    "crew-pm": { cli: true, dispatch: true, web: true },
    "crew-pm-cli": { cli: true, dispatch: true, web: true },
    "crew-pm-frontend": { cli: true, dispatch: true, web: true },
    "crew-pm-core": { cli: true, dispatch: true, web: true },

    // Coding agents: file + CLI tools
    "crew-coder": { cli: true, dispatch: true, web: true },
    "crew-coder-front": { cli: true, dispatch: true, web: true },
    "crew-coder-back": { cli: true, dispatch: true, web: true },
    "crew-fixer": { cli: true, dispatch: true, web: true },
    "crew-frontend": { cli: true, dispatch: true, web: true },

    // Review agents: read-only + web
    "crew-qa": { cli: true, dispatch: true, web: true },
    "crew-security": { cli: false, dispatch: false, web: true },

    // Writing agents: files + web
    "crew-copywriter": { cli: true, dispatch: false, web: true },
    "crew-researcher": { cli: false, dispatch: false, web: true },

    // Chat-only agents: web only
    "crew-loco": { cli: false, dispatch: false, web: true },

    // Coordinators: full access
    "crew-main": { cli: true, dispatch: true, web: true },
    "crew-lead": { cli: true, dispatch: true, web: true },
  };

  const basePermissions = defaults[agentId] || {
    cli: true,
    dispatch: true,
    web: true,
  };

  // Override with explicit config if present
  if (crewswarmAllow.length > 0) {
    return {
      cli:
        crewswarmAllow.includes("run_cmd") ||
        crewswarmAllow.includes("write_file"),
      dispatch: crewswarmAllow.includes("dispatch"),
      web:
        crewswarmAllow.includes("web_search") ||
        crewswarmAllow.includes("web_fetch"),
    };
  }

  return basePermissions;
}
