# God-File Split — Detailed Refactor Plan

> Status tracking for ROADMAP Phase 1. Update checkboxes as each slice lands.
> Rule: `node --check <file>` + smoke dispatch must pass after every extraction.

---

## 1. `frontend/src/app.js` (5778 LOC → bootstrap + router only)

### Already done
- [x] `frontend/src/core/api.js` — `getJSON`, `postJSON`
- [x] `frontend/src/core/dom.js` — `escHtml`, `showNotification`, `fmt`, `createdAt`, `appendChatBubble`
- [x] `frontend/src/core/state.js` — shared state (`activeProject`, `lastKnownAgents`, etc.)
- [x] `frontend/src/tabs/benchmarks-tab.js` — `showBenchmarks`, `loadBenchmarkOptions`, `loadBenchmarkLeaderboard`

### Remaining tabs

#### `frontend/src/tabs/agents-tab.js`
- [ ] `showAgents()`, `loadAgents()`, `renderAgentCard()`
- [ ] `updateAgentModel()`, `saveAgentConfig()`, `restartAgent()`
- [ ] `toggleAgentExecutor()`, `setAgentRoute()`
- Verify: build passes, agents tab loads in dashboard

#### `frontend/src/tabs/services-tab.js`
- [ ] `showServices()`, `loadServices()`
- [ ] `startService()`, `stopService()`, `restartService()`
- [ ] `renderServiceStatus()`
- Verify: build passes, services tab loads

#### `frontend/src/tabs/chat-tab.js`
- [ ] `showChat()`, `sendChat()`, `handleChatStream()`
- [ ] `loadChatHistory()`, `clearChat()`
- [ ] RT connection + DLQ handlers (if not shared)
- Verify: build passes, chat sends and receives

#### `frontend/src/tabs/skills-tab.js`
- [ ] `showSkills()`, `loadSkills()`, `importSkillFromUrl()`
- [ ] `deleteSkill()`, `runSkill()`
- Verify: build passes, skills tab loads

#### `frontend/src/tabs/providers-tab.js`
- [ ] `showProviders()`, `loadProviders()`, `saveProviderKey()`
- [ ] `testProvider()`
- Verify: build passes, providers tab loads

#### `frontend/src/tabs/settings-tab.js`
- [ ] `showSettings()`, `showSettingsTab()`, `loadEnvAdvanced()`, `saveEnvVar()`
- [ ] `showEngines()`, `loadEngines()`, `importEngineFromUrl()`, `deleteEngine()`
- [ ] All settings sub-tab handlers
- Verify: build passes, all settings sub-tabs work

#### `frontend/src/tabs/projects-tab.js`
- [ ] `showProjects()`, `loadProjects()`, `setActiveProject()`
- [ ] `createProject()`, `deleteProject()`
- Verify: build passes, projects tab loads

### Final cleanup
- [ ] `app.js` contains only: imports, `NAV_VIEW_MAP`, `ACTION_REGISTRY`, `Object.assign(window,...)`, `init()`
- [ ] No tab-specific logic remaining in `app.js`
- [ ] `core/state.js` owns all shared globals (remove local `selected`, `agents`, `_...` vars from top of app.js)

---

## 2. `gateway-bridge.mjs` (5400 LOC → orchestration shell only)

### Module plan

#### `lib/engines/shared.mjs`
- [ ] `getOpencodeProjectDir()`
- [ ] `extractProjectDirFromTask()`
- [ ] `buildMiniTaskForOpenCode()`
- [ ] `getAgentOpenCodeConfig()`

#### `lib/engines/opencode.mjs`
- [ ] `runOpenCodeTask()`
- [ ] `shouldUseOpenCode()`
- [ ] `runOuroborosStyleLoop()` (opencode variant)
- imports from `./shared.mjs`

#### `lib/engines/claude-code.mjs`
- [ ] `runClaudeCodeTask()`
- [ ] `shouldUseClaudeCode()`

#### `lib/engines/cursor-cli.mjs`
- [ ] `runCursorCliTask()`
- [ ] `shouldUseCursorCli()`

#### `lib/engines/codex.mjs`
- [ ] `runCodexTask()`
- [ ] `shouldUseCodex()`

#### `lib/engines/docker-sandbox.mjs`
- [ ] `runDockerSandboxTask()`
- [ ] `shouldUseDockerSandbox()`

#### `lib/engines/index.mjs`
- [ ] Re-exports all of the above

#### `lib/agents/registry.mjs`
- [ ] `loadAgentList()`
- [ ] `shouldUseCursorCli()` / routing guard helpers
- [ ] Agent config lookup helpers

#### `lib/tools/executor.mjs`
- [ ] `handleToolCall()` — `@@READ_FILE`, `@@WRITE_FILE`, `@@MKDIR`, `@@RUN_CMD`, `@@GIT`
- [ ] `checkToolPermission()`
- [ ] `AGENT_TOOL_ROLE_DEFAULTS`

### Acceptance criteria
- [ ] `node --check gateway-bridge.mjs` passes
- [ ] `node scripts/smoke-dispatch.mjs` passes
- [ ] All 19 agents register on RT bus after restart
- [ ] gateway-bridge.mjs < 1000 LOC (orchestration + imports only)

---

## 3. `crew-lead.mjs` (5444 LOC → HTTP server + bootstrap only)

### Module plan

#### `lib/http/router.mjs`
- [ ] Route table — maps `pathname + method` to handler functions
- [ ] `checkBearer()`

#### `lib/pipeline/dispatcher.mjs`
- [ ] `@@DISPATCH` parsing + RT publish
- [ ] `@@PIPELINE` wave execution
- [ ] `@@STOP` / `@@KILL` handlers
- [ ] Task status tracking (`taskStore`)

#### `lib/skills/runner.mjs`
- [ ] `@@SKILL` resolution
- [ ] Skill JSON loader
- [ ] Skill HTTP executor

#### `lib/background/consciousness.mjs`
- [ ] Background loop timer
- [ ] Brain/reflect cycle
- [ ] `NO_ACTION` filter

#### `lib/runtime/config.mjs`
- [ ] `loadConfig()` — reads `crewswarm.json`
- [ ] `loadAgentPrompt()`
- [ ] env bootstrap

### Acceptance criteria
- [ ] `node --check crew-lead.mjs` passes
- [ ] `curl http://127.0.0.1:5010/health` returns `ok: true`
- [ ] Chat message dispatches correctly to an agent
- [ ] crew-lead.mjs < 500 LOC (server setup + composition only)

---

## Execution order (lowest risk first)

1. `lib/engines/` — pure async functions, no side effects, easiest to extract
2. `frontend/src/tabs/` — UI only, build validates each step
3. `lib/tools/executor.mjs` — isolated tool handler
4. `lib/agents/registry.mjs` — lookup helpers
5. `lib/pipeline/dispatcher.mjs` — core but well-defined boundary
6. `lib/http/router.mjs` + `lib/skills/runner.mjs`
7. `lib/background/consciousness.mjs`
8. Final cleanup of both entrypoints

---

## Who should do what

| Module | Best agent | Why |
|---|---|---|
| `lib/engines/*` | crew-mega (Claude Code) | Pure function extraction, needs to read 5400 LOC accurately |
| `frontend/src/tabs/*` | crew-coder or crew-coder-front (Cursor) | UI tab extraction, build validates each step |
| `lib/tools/executor.mjs` | crew-coder-back (Cursor) | Backend tool logic |
| `lib/pipeline/dispatcher.mjs` | crew-mega (Claude Code) | Complex orchestration logic, needs accuracy |
| `lib/http/router.mjs` | crew-coder-back (Cursor) | Mechanical route extraction |

**Never assign these tasks to direct-LLM agents** (crew-main, crew-pm, crew-qa, crew-copywriter) — they will write stubs.
