# Dashboard Tabs

The crewswarm dashboard at `http://127.0.0.1:4319` is the primary control plane for service management, system configuration, and swarm observation. It currently exposes 24 top-level views in the sidebar.

## Core Chat & Observation
- **Chat** (`chat`): Direct conversation with `crew-lead`.
- **Swarm Chat** (`swarm-chat-tab.js`): The primary chat interface. Interact with `crew-lead` and use `@mentions` (`@crew-coder`, `@crew-qa`) to autonomously route tasks. All threads are persisted to the active project context.
- **Swarm** (`swarm-tab.js`): Live overview of the RT message bus and the 20+ agents handling workloads.
- **RT Messages** (`rt`): Live RT bus message stream and transport-level visibility.
- **Build** (`build`): Build/task execution visibility for active work.
- **Files** (`files`): File-browser view for the active project.
- **DLQ** (`dlq`): Dead-letter queue inspection and replay.
- **Waves** (`waves-tab.js`): Monitor execution queues for tasks dispatched in parallel waves.
- **Projects** (`projects-tab.js`): Create, select, and manage active project contexts. Enforces strict session and RAG thread continuity across chat and CLI modes.

## Settings & Configuration
- **Agents** (`agents-tab.js`): View the 20+ specialized agents, explicitly map them to specific underlying LLM models, and toggle their active state.
- **Engines** (`engines-tab.js`): Select the runtime execution engine globally or per-agent (e.g., OpenCode, Cursor CLI, Claude Code, Direct API). 
- **Models** (`models-tab.js`): Primary Provider setup. Input API keys for Groq, Anthropic, OpenAI, Cerebras, etc., and confirm fallback pipelines.
- **Prompts** (`prompts-tab.js`): View and tweak the native system prompts injected into every agent at runtime.
- **Settings** (`settings-tab.js`): Global behavior settings, including Ouroboros loops (`opencodeLoop`), debug verbosity, and system-wide file permissions.
- **CLI Process** (`cli-process.js`): L1/L2/L3 model-slot configuration, orchestration status, and worker concurrency controls.
- **Services** (`services-tab.js`): Operational health checks. Start, stop, and restart the 12 core system processes (RT bus, Code Engine, Vibe Watch Server, MCP, etc).

## Knowledge & Assets
- **Memory** (`memory-tab.js`): Search and introspect `AgentMemory` (facts), `AgentKeeper` (results), and trigger legacy brain compactions or migrations.
- **Skills** (`skills-tab.js`): View injected framework instructions (Markdown knowledge skills) and available external API targets (JSON endpoints).
- **Run Skills** (`run-skills`): Invoke installed skills directly from the dashboard.
- **Workflows** (`workflows-tab.js`): Saved multi-agent macros mapped to trigger instructions.

## Development & QA
- **Testing** (`testing-tab.js`): Run the full test suite (4,355 tests across 273 files) and watch live progress. Shows per-suite pass/fail breakdown, streaming log output, and run history. Powered by the `/api/test-run` SSE endpoint.

## Integrations & Telemetry
- **Comms** (`comms-tab.js`): Setup for WhatsApp (Baileys) and Telegram bridge QR codes and bot tokens.
- **Contacts** (`contacts-tab.js`): View unified contacts pulled from communication bridges and their LLM-extracted preferences.
- **Benchmarks** (`benchmarks-tab.js`): Query real-time LLM benchmark leaderboards (SWE-Bench, LiveCodeBench, etc) via ZeroEval.
- **Spending** (`spending-tab.js`): Financial tracking. View estimated token spend mapped to specific providers and agents.
- **Tool Matrix** (`tool-matrix`): Inspect agent-to-tool availability and fast operational controls.
- **Usage** (`usage-tab.js`): View granular raw telemetry and token usage logs per task execution.
