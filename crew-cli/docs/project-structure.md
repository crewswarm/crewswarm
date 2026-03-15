# crew-cli Project Structure (v0.1.0-alpha)

## 🏎️ Overview
`crew-cli` is a high-performance multi-agent orchestrator that bridges your terminal with 20+ specialized AI agents. It uses a **3-Tier LLM Architecture** (Routing -> Planning -> Execution) and a safety-first **Cumulative Diff Sandbox**.

## 📂 Directory Structure

```text
crew-cli/
├── bin/
│   └── crew.js              # Executable CLI entry point
├── dist/                    # Bundled output (dist/crew.mjs)
├── docs/                    # Comprehensive documentation & marketing
│   ├── marketing/           # Website, optimized demo videos, and SEO assets
│   ├── SHARED-MEMORY.md     # Cognitive continuity & team sync guide
│   └── ...
├── scripts/                 # Automation scripts (Video generation, benchmarks)
├── src/
│   ├── agent/               # Agent discovery, routing, and dispatch
│   ├── autofix/             # Background AutoFix worker loops
│   ├── cache/               # Token caching (cost optimization)
│   ├── cli/                 # Commander.js entry and command definitions
│   ├── collections/         # Local RAG / TF-IDF indexing for docs
│   ├── config/              # Model policies, repo-level config, and user settings
│   ├── context/             # Git, repo, and multi-repo context auto-injection
│   ├── cost/                # Real-time token and USD tracking per model
│   ├── hello/               # Branded ASCII banners and CLI greetings
│   ├── lsp/                 # TypeScript Language Service integration
│   ├── mapping/             # Dependency-aware repository graph generation
│   ├── memory/              # AgentKeeper (Task) and AgentMemory (Fact) layers
│   ├── orchestrator/        # 3-Tier router and Tier 3 Worker Pool
│   ├── pty/                 # Pseudo-terminal support for interactive tools
│   ├── repl/                # Interactive multi-agent shell with slash commands
│   ├── sandbox/             # Cumulative diff store with branching and rollback
│   ├── shell/               # Natural language shell command translation
│   ├── strategies/          # Vendored edit strategies (SEARCH/REPLACE, diff)
│   ├── tools/               # Extensible tool execution framework
│   └── utils/               # Unified logging and core utilities
├── tests/                   # 90+ unit and integration tests (Native node:test)
├── tools/                   # QA contract tests and matrix benchmarks
└── package.json             # ES module configuration & dependencies
```

## 🏗️ Core Architectural Components

### 1. 3-Tier LLM Execution
- **Tier 1 (Router)**: Uses `src/orchestrator` to classify requests into CHAT, CODE, or DISPATCH using Gemini 2.0 Flash.
- **Tier 2 (Planner)**: Uses `src/planner` to decompose complex tasks into sequential or parallel steps.
- **Tier 3 (Workers)**: Uses `src/orchestrator/worker-pool.ts` to execute micro-tasks in parallel with bounded concurrency.

### 2. The Memory System
- **AgentKeeper**: Persistent local task results store with lexical similarity recall.
- **AgentMemory**: cognitive fact persistence shared across execution tiers.
- **MemoryBroker**: The central hub in `src/memory/broker.ts` that unifies Task, Fact, and Docs context.

### 3. Safety & DevEx
- **Sandbox**: A virtual filesystem in `src/sandbox` that prevents AI from overwriting code until explicitly approved.
- **LSP Service**: Real-time type-checking and completions in `src/lsp`.
- **Blast Radius**: Impact analysis based on the dependency graph in `src/mapping`.

## 📦 Build & Runtime
- **Language**: 100% TypeScript.
- **Bundler**: `esbuild` (produces a single `dist/crew.mjs`).
- **Runtime**: Node.js 20+ (ESM).
- **Communication**: HTTP REST + WebSocket RT Bus to the CrewSwarm gateway.

---
**crew-cli** is built for speed, safety, and scale. 🚀
