# crew-cli Overview: The Multi-Agent Coding Orchestrator

## 🏎️ What is it?
`crew-cli` is a command-line power-tool that bridges your terminal with a crew of 20+ specialized AI agents. It orchestrates complex coding tasks by routing them to experts (Coder, QA, PM, Fixer, Security) while ensuring your filesystem stays safe via a cumulative diff sandbox.

## 🛠️ The Core Value Loop
1. **Intelligent Routing**: `crew chat` or `crew plan` automatically routes your request to the right specialist.
2. **Context Auto-Injection**: It automatically reads your git status, branch, and diffs so the agent always knows the current state.
3. **Cumulative Sandbox**: AI suggestions aren't applied directly. They sit in a `.crew/sandbox.json` where you can `preview` and `branch` them.
4. **Safety Gates**: `crew apply --check "npm test"` only writes to disk if your tests pass.

## 🚀 Key Features
- **3-Tier LLM Scale-Up**:
  - **Tier 1 (Router)**: Cheap/fast classification (Gemini 2.0 Flash).
  - **Tier 2 (Planner)**: Decomposition + strategy (Claude 3.5 Sonnet).
  - **Tier 3 (Workers)**: Parallel micro-task execution with bounded concurrency (`crew plan --parallel`).
- **DevEx Foundations**:
  - **LSP Support**: Type checking and completions via `crew lsp-check` and `crew lsp-complete`.
  - **Interactive PTY**: Run terminal tools like `vim` or `htop` directly via `crew exec`.
  - **Repository Graph**: Visual dependency mapping with `crew map`.
  - **Visual Ingestion**: Image/screenshot context via `--image <path>`.
- **Specialist Crews**: Routes to 20+ specific roles (React, Backend, Security, PM, etc.).
- **Speculative Implementation**: `crew branch experiment-1` allows you to try multiple AI solutions side-by-side.
- **Cost Efficiency**: `crew auth` finds your existing session tokens from Claude Code, Cursor, and Gemini to avoid paying double for API keys.
- **Advanced Workflows**: 
  - **Token Caching**: Avoids repeated model calls for unchanged tasks/context (`crew cost` for stats).
  - **Blast Radius**: Predicts and gates high-risk refactors before apply.
  - **Collections Search**: Local RAG over `docs/` and markdown files (`crew docs`).
  - **AgentKeeper Memory**: Shared cross-run persistence to reuse successful patterns.
  - **Voice Mode**: STT/TTS integration for hands-free orchestration.

## 📦 Zero-Config Architecture
- **Language**: TypeScript (esbuild bundled).
- **Communication**: HTTP REST + WebSocket RT Bus to the CrewSwarm gateway.
- **State**: Stored in a local `.crew/` folder per project.

---
**crew-cli** is not just an assistant; it's a team of senior engineers in your terminal. 🦾
