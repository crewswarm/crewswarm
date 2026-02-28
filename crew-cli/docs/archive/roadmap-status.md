# crew-cli Roadmap Status Report

**Generated:** 2026-02-28
**Source:** ROADMAP.md + filesystem inspection + STATUS.md

---

## Summary

| Status | Count |
|--------|-------|
| Complete [x] | 10 items |
| Pending [ ] | 47 items |
| Failed [!] | 0 items |

---

## Phase 1: MVP — Core Infrastructure

### 1. Project Setup & Scaffolding
- [x] Initialize TypeScript package in `crew-cli/`
- [x] Set up `tsconfig.json` with ES modules, strict mode
- [x] Create `package.json` with bin entry `crew`
- [x] Install dependencies: chalk, commander, ora, inquirer, ws (node_modules confirmed)
- [x] Create basic folder structure: `src/`, `bin/`, `lib/`, `dist/`
- [ ] Set up build pipeline (esbuild) — no esbuild script found
- [ ] Create `.gitignore`, exclude `dist/`, `node_modules/`

**Notes:** Core scaffolding complete. Missing esbuild pipeline.

---

### 2. Git Context Auto-Injection
- [ ] Create `src/context/git.ts` — **FILE IS A 1-LINE STUB** (not implemented)
- [ ] Implement `getProjectContext(cwd)` function
- [ ] Read `git branch --show-current`
- [ ] Read `git status --short`
- [ ] Read `git diff` and `git diff --staged`
- [ ] Read `git log -5 --oneline`
- [ ] Format as markdown context block
- [ ] Handle non-git directories gracefully
- [ ] Auto-inject into every LLM prompt

**Notes:** `src/context/git.ts` exists on disk but contains only 1 line. Effectively unimplemented.

---

### 3. Dual-LLM Router (Orchestrator + Executor)
- [ ] Create `src/orchestrator/index.ts`
- [ ] Initialize Groq client (llama-3.3-70b) for routing
- [ ] Initialize executor clients (Claude, Grok, DeepSeek)
- [ ] Implement routing logic: CHAT | CODE | DISPATCH | SKILL
- [ ] Route decision based on user input + project state
- [ ] Track which model handled which request
- [ ] Log routing decisions to `.crew/routing.log`
- [ ] Cost tracking per model

**Notes:** Not started. `src/agent/router.js` is a CrewSwarm HTTP client — different from the Groq-based dual-LLM router described here.

---

### 4. Vendored Edit Strategies from Aider
- [ ] Create `src/strategies/` folder
- [ ] Port editblock strategy to TypeScript
- [ ] Port unified-diff strategy
- [ ] Port whole-file strategy
- [ ] Port search-replace strategy
- [ ] Create strategy selector

**Notes:** Not started. No `src/strategies/` directory exists.

---

### 5. Cumulative Diff Sandbox (from Plandex)
- [ ] Create `src/sandbox/index.ts`
- [ ] Implement `Sandbox` class
- [ ] Track file state: `Map<path, {original, modified}>`
- [ ] `addChange()`, `preview()`, `apply()`, `rollback()` methods
- [ ] Branch support
- [ ] Persist to `.crew/sandbox.json`

**Notes:** Not started.

---

### 6. CrewSwarm Gateway Integration
- [x] Create `src/agent/router.js` — HTTP client for gateway at port 5010
- [x] Implement `dispatch()`, `pollTaskStatus()`, `listAgents()`, `getStatus()`
- [x] Read auth/config from `~/.crewswarm/config.json` (via ConfigManager)
- [ ] Support skills: `callSkill(name, params)`
- [ ] Read from `memory/brain.md` for context
- [ ] Support `@@DISPATCH` syntax in responses

**Notes:** Core HTTP client done and tested (6 tests passing). Skills, brain.md injection, and @@DISPATCH syntax not implemented.

---

### 7. Session State Management
- [ ] Create `.crew/` directory in project root
- [ ] Store `session.json` (chat history)
- [ ] Store `routing.log`
- [ ] Store `cost.json`
- [ ] Store `sandbox.json`
- [ ] Resume session on restart
- [ ] `crew clear` command

**Notes:** Not started. No `.crew/` directory exists.

---

### 8. Basic Terminal UI
- [x] `bin/crew.js` executable with chalk, ora, commander wired up
- [x] `src/cli/index.js` — CLI interface with commander
- [ ] Streaming output for LLM responses
- [ ] Syntax highlighting for code blocks
- [ ] Diff preview before applying changes
- [ ] Confirmation prompts (inquirer)

**Notes:** Skeleton UI exists. Streaming, highlighting, and diff preview not implemented.

---

### 9. OAuth Token Finder
- [ ] Create `src/auth/token-finder.ts`
- [ ] Find Claude Code session token
- [ ] Find Cursor auth from SQLite
- [ ] Find Gemini OAuth credentials
- [ ] Find OpenAI config
- [ ] Fallback to API keys from `~/.crewswarm/crewswarm.json`

**Notes:** Not started.

---

### 10. Engine Integrations
- [ ] Gemini API direct (`@google/generative-ai`)
- [ ] Claude API direct (`@anthropic-ai/sdk`)
- [ ] Gemini CLI subprocess
- [ ] Codex CLI subprocess
- [ ] Claude Code CLI subprocess

**Notes:** Not started. No engine integration files exist.

---

### 11. Plan-First Workflow
- [ ] Create `src/planner/index.ts`
- [ ] `planFeature()` — 5-10 step plan
- [ ] Present for user approval
- [ ] Execute steps + add to sandbox
- [ ] Cumulative diff at end

**Notes:** Not started.

---

### 12. Installer Script
- [ ] Create `installer/install.sh`
- [ ] Node.js >= 20 check
- [ ] Optional CLI checks (Aider, Gemini, Codex, Claude)
- [ ] OAuth token auto-detection
- [ ] `crew doctor` diagnostic tool

**Notes:** Not started.

---

## Phase 2–4: Not Started

All Phase 2 (Intelligence), Phase 3 (Polish & Launch), and Phase 4 (Advanced Features) items are **pending [ ]**. No work has begun.

---

## Failed Items [!]

**None.** No tasks are in a failed state. The 6 existing tests all pass.

---

## Next Logical Task

**Task:** Implement Git Context Auto-Injection (`src/context/git.ts`)

**Why this is next:**
- The file exists as a 1-line stub — easiest win to close out
- Git context is foundational: it must auto-inject into every LLM prompt, so all engine integrations depend on it
- It's a self-contained module with no external dependencies beyond Node.js `child_process`
- Completing it unblocks Items 3, 10, and 11 which all need project context

**Agent:** `crew-coder`

**Scope:**
1. Implement `getProjectContext(cwd: string): Promise<string>` in `src/context/git.ts`
2. Run `git branch`, `git status --short`, `git diff`, `git diff --staged`, `git log -5 --oneline`
3. Format output as a markdown code block
4. Handle non-git directories gracefully (no crash)
5. Export for use in the CLI and future orchestrator

**After that:**
- Session State Management (Item 7) — `crew-coder`
- Dual-LLM Router (Item 3) — `crew-coder-back`
- Edit Strategies (Item 4) — `crew-coder`
