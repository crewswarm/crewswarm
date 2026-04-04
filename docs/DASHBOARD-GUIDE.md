# Dashboard Guide

The crewswarm dashboard runs at `http://localhost:4319`. It is the primary web UI for managing agents, chatting, dispatching tasks, and monitoring the system.

Screenshots of key views are in `website/screenshots/` — see `dashboard-chat.webp`, `dashboard-build.webp`, `dashboard-swarm.webp`, `dashboard-agents.webp`, `dashboard-services.webp`, `dashboard-engines.webp`, `dashboard-settings.webp`, `dashboard-rt-messages.webp`, `dashboard-projects.webp`, `dashboard-workflows.webp`, `dashboard-memory.webp`, and `vibe-ide.webp`.

Start it with:

```bash
crewswarm
# or from source:
npm run restart-all
```

## Navigation

The left sidebar lists every view. Click a tab to switch, or navigate directly via URL hash:

```
http://localhost:4319/#chat
http://localhost:4319/#swarm
http://localhost:4319/#build
```

The sidebar collapses on narrow screens. Most views update in real time via WebSocket.

---

## Views

### Chat (`#chat`)

Main conversation with crew-lead. This is where most users spend their time.

**What you can do:**
- Type a message and crew-lead routes it to the right agent
- Dispatch agents explicitly: type `dispatch crew-coder to build a REST API` or use the `@@DISPATCH crew-coder "task description"` syntax
- Ask questions about your project, request code changes, run builds
- View streamed agent responses as they execute
- Use the project selector at the top to set which project directory gets the work

**Tips:**
- crew-lead decides which agent handles your message. You do not need to pick one manually.
- For multi-step builds, the Build tab is more structured. Chat is better for quick tasks and questions.
- If an agent seems stuck, type `@@STOP` to halt the current task or `@@KILL` to force-terminate.

### Swarm Chat (`#swarm-chat`)

Multi-agent chat room where you `@mention` agents directly.

**What you can do:**
- `@crew-coder fix the auth middleware` -- dispatches directly to crew-coder
- `@crew-qa run the test suite` -- dispatches to crew-qa
- See all agent responses in a shared timeline
- Multiple agents can work simultaneously

**How it differs from Chat:**
- Chat goes through crew-lead, which decides the routing. Swarm Chat lets you bypass crew-lead and talk to agents directly.
- Swarm Chat shows messages from all agents in one stream. Chat is a 1:1 conversation with crew-lead.
- Use Chat for general work. Use Swarm Chat when you want to coordinate multiple agents yourself.

### Swarm (`#swarm`)

Agent overview -- see which agents are online, their engines, models, and recent activity.

**What you can do:**
- See all registered agents and their current status (idle, busy, offline)
- Check which engine and model each agent is using
- View recent task history per agent

**Tips:**
- If an agent shows as offline, check the Services tab to restart its bridge process.

### RT Messages (`#rt`)

Real-time bus traffic. Every message flowing between agents appears here.

**What you can do:**
- Watch live message flow on the RT bus (port 18889)
- Filter by agent, message type, or task ID
- Inspect message payloads

**Tips:**
- This is a diagnostic view. Use it when debugging agent communication issues.
- High message volume is normal during parallel builds.

### DLQ (`#dlq`)

Dead letter queue -- tasks that failed and were not retried.

**What you can do:**
- See failed tasks with error details
- Replay a failed task (re-dispatches it)
- Clear old entries

**Tips:**
- Tasks land in the DLQ after exhausting retries. Common causes: model API errors, tool permission blocks, timeouts.
- Replay is safe -- it creates a new task attempt.
- A badge on the sidebar shows the current DLQ count.

### Files (`#files`)

File browser for your project directory.

**What you can do:**
- Browse the file tree
- Read file contents inline
- See which files agents have modified

**Tips:**
- This is read-only from the dashboard. Agents write files via their tool permissions.

### Services (`#services`)

Service health for all crewswarm processes.

**What you can do:**
- See status of crew-lead, dashboard, RT daemon, MCP server, bridges
- Start, stop, or restart individual services
- Check uptime and port bindings

**Tips:**
- Do not restart the dashboard from within the dashboard -- it will fail (race condition). Use `npm run restart-dashboard` from terminal instead.
- crew-lead must be running for Chat, dispatch, and builds to work.
- Check here first when something is not responding.

### Agents (`#agents`)

Agent configuration -- models, engines, roles, and tool permissions.

**What you can do:**
- Change which engine an agent uses (Claude Code, Cursor, Gemini, Codex, OpenCode)
- Set model overrides per agent
- Toggle engine flags like `useClaudeCode`, `useCursorCli`, `useGeminiCli`
- Edit agent roles and descriptions
- Reset agent sessions to clear state

**Tips:**
- Changes take effect on the next task dispatch. Running tasks keep their original config.
- Tool permissions are configured in `~/.crewswarm/crewswarm.json`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for details.

### Models (`#models`)

Browse available models across all configured providers.

**What you can do:**
- See models grouped by provider (Anthropic, OpenAI, Google, Groq, etc.)
- Check which models are available with your current API keys
- View model capabilities and context windows

### Settings (`#settings`)

System-wide configuration.

**What you can do:**
- Set the RT bus token
- Toggle engine availability (Cursor Waves, Claude Code default, etc.)
- Configure autonomous mentions (allow agents to @mention each other)
- Set spending caps per session or per day
- Edit global rules (command allowlists, safety blocks)
- Enable background consciousness for agents

**Tips:**
- Spending caps are per-provider. Set them to avoid surprise bills during long autonomous runs.
- The command allowlist controls which shell commands agents can run. Pre-approve patterns like `npm *`, `node *` to reduce approval prompts.

### Engines (`#engines`)

Engine status -- which CLI engines are installed and available.

**What you can do:**
- See installed engines (Claude Code, Cursor agent, Gemini CLI, Codex CLI, OpenCode)
- Check version and availability
- Toggle engines on or off
- Test engine connectivity

**Tips:**
- An engine must be installed on your system to appear here. crewswarm does not install engines for you.
- See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for engine-specific issues (Cursor keychain, Codex MCP, etc.).

### Skills (`#skills`)

Custom skills -- reusable workflows that agents can execute.

**What you can do:**
- Browse imported skills
- Import new skills from SKILL.md files or JSON definitions
- View skill parameters and descriptions
- Delete unused skills

**Tips:**
- Skills appear as both `api` type (executable) and `knowledge` type (reference docs).
- If the tab shows fewer skills than expected, restart crew-lead.

### Run Skills (`#run-skills`)

Execute a skill against your project.

**What you can do:**
- Pick a skill from the list
- Fill in parameters
- Run and see results

### Benchmarks (`#benchmarks`)

Compare engine performance on standardized tasks.

**What you can do:**
- Run benchmark suites across engines
- Compare latency, token usage, and pass rates
- View historical benchmark results

### Tool Matrix (`#tool-matrix`)

See which tools each agent has access to.

**What you can do:**
- View the full matrix of agents vs. tools (read_file, write_file, run_cmd, etc.)
- Identify permission gaps
- Debug why an agent cannot perform a specific action

**Tips:**
- Tool permissions come from role defaults in `lib/tools/executor.mjs` and overrides in `~/.crewswarm/crewswarm.json`.

### Build (`#build`)

One-click build -- the most structured way to go from requirement to working code.

**What you can do:**
1. Type a requirement (e.g., "Build a REST API with auth and tests")
2. Pick an engine (or leave on auto)
3. crew-pm generates a build plan with phases and agent assignments
4. Review the plan, then execute
5. Agents work in parallel waves -- backend, frontend, tests built simultaneously

**Build workflow in detail:**
- **Plan phase:** crew-pm breaks the requirement into tasks, assigns agents, orders into waves. The enhance-prompt step refines vague input into a concrete brief.
- **Execute phase:** agents run in parallel per wave, results stream back to the UI. Use "Run Build" for one pass or "Build Until Done" to loop until the roadmap is exhausted.
- **PM Loop:** reads `ROADMAP.md` and dispatches each item one at a time. Start/stop controls and log output are inline.

**Tips:**
- For simple tasks, Chat is faster. Use Build for multi-file features that benefit from planning.
- You can edit the plan before executing.
- If a build fails mid-way, check the DLQ for failed tasks.
- Engine routing is automatic by default based on task keywords. See [ORCHESTRATION-PROTOCOL.md](ORCHESTRATION-PROTOCOL.md) for the keyword list.

### Messaging (`#messaging`)

Communication bridge configuration for Telegram and WhatsApp.

**What you can do:**
- Configure Telegram bot token and chat ID
- Configure WhatsApp bridge settings
- See bridge connection status
- Test message delivery

**Tips:**
- Messaging bridges let you chat with crew-lead from Telegram or WhatsApp instead of the dashboard.
- See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if you get duplicate replies.

### Projects (`#projects`)

Project management -- switch between different codebases.

**What you can do:**
- Create new projects (each points to a directory on disk)
- Switch the active project
- View project history and recent tasks
- Run the PM Loop for a specific project

**Tips:**
- Each project gets its own context and history so agents stay scoped.
- Use the project selector in Chat or switch here.

### Contacts (`#contacts`)

Contact management for messaging bridges.

**What you can do:**
- Add contacts for Telegram/WhatsApp bridges
- Manage who can interact with your crewswarm instance via messaging

### Memory (`#memory`)

Shared agent memory -- the knowledge base that persists across sessions.

**What you can do:**
- Search memory entries
- View memory stats (entries, size)
- Compact memory (merge redundant entries)
- Clear stale entries

**Tips:**
- Memory is stored as markdown in the `memory/` directory. crew-scribe writes `brain.md` and `session-log.md` automatically.

### Workflows (`#workflows`)

Scheduled workflows and cron jobs.

**What you can do:**
- Create automated workflows that run on a schedule
- Edit cron expressions
- Enable/disable workflows
- View execution history

### Testing (`#testing`)

Run the full test suite from the dashboard without touching the terminal.

**What you can do:**
- Click **Run Tests** to execute all 4,355 tests across 273 files
- Watch live streaming output with pass/fail counts per suite
- Inspect the per-suite breakdown (unit, integration, E2E, browser)
- Browse run history to compare results across sessions

**Tips:**
- The Testing tab uses the `/api/test-run` SSE endpoint to stream output in real time.
- You can filter by suite name to focus on a specific area.
- Failed suites are highlighted in red with expandable error detail.

---

### CLI Process (`#cli-process`)

Running CLI engine processes.

**What you can do:**
- See active Claude Code, Cursor, Codex, and Gemini sessions
- View stdout/stderr output from engine processes
- Kill stuck processes

**Tips:**
- Each dispatched task that uses a CLI engine spawns a process here. They terminate when the task completes.

### Prompts (`#prompts`)

Edit agent system prompts.

**What you can do:**
- View and edit the system prompt for each agent
- Customize agent behavior and instructions
- Reset to defaults

**Tips:**
- Prompt changes take effect on the next task. Running tasks use the prompt they started with.

---

## Common workflows

### Dispatch an agent from Chat

Type naturally:

```
dispatch crew-coder to build a login page with JWT auth
```

Or use the formal syntax:

```
@@DISPATCH crew-coder "build a login page with JWT auth"
```

### Stop a running task

```
@@STOP
```

Force-kill (no cleanup):

```
@@KILL
```

### Switch engines mid-session

Go to **Agents** tab, change the engine for the target agent, then dispatch a new task. The next task uses the new engine.

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) -- system diagram, ports, request flow
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) -- common issues and fixes
- [CREW-CLI-GUIDE.md](CREW-CLI-GUIDE.md) -- terminal-first interface
- [ORCHESTRATOR-GUIDE.md](ORCHESTRATOR-GUIDE.md) -- pipeline DSL and wave execution
