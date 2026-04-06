# Backlinks Strategy & Launch Campaigns

## 1. Backlinks Campaign
**Status**: Can start now
**Goal**: Build high-quality backlinks across AI directories and developer communities to improve SEO and discoverability.

### AI & Developer Directories
Submit CrewSwarm to the following platforms:
- [ ] **There's An AI For That**
- [ ] **Futurepedia**
- [ ] **Toolify.ai**
- [ ] **DevHunt**
- [ ] **AlternativeTo** (as an alternative to GitHub Copilot / Cursor)
- [ ] **Product Hunt** (see section 2)

### Reddit Strategy
Engage authentically in the following subreddits. Do not spam; focus on sharing the technical challenges solved (e.g., how the multi-agent websocket bus or shared memory works).
- [ ] **r/LocalLLaMA**: Focus on the multi-provider LLM support and self-hosted capabilities.
- [ ] **r/OpenAI**: Highlight the Ouroboros loop (LLM ↔ Engine iterative refinement).
- [ ] **r/singularity**: Broad discussion on multi-agent collaboration (crew-pm orchestrating crew-coder).
- [ ] **r/webdev** / **r/reactjs**: Focus on the dashboard chat and agent capabilities.
- [ ] **r/macapps**: Promote the native CrewChat.app macOS application.

### Hacker News (Show HN)
**Title Draft**: `Show HN: CrewSwarm – Multi-agent orchestration layer for OpenCode and Cursor`
**Approach**: Post ideally on a Tuesday or Wednesday morning (~8 AM EST). The first comment should explain the 3-tier architecture (Router/Executor/Workers) and how this solves the context loss problems between isolated coding sessions.

---

## 2. Product Hunt Launch Post
**Status**: Draft ready

**Product Name**: CrewSwarm
**Tagline**: Bring 20+ specialized AI agents to your IDE
**Description**: 
CrewSwarm is an open-source orchestration layer that connects a team of specialist AI agents (coder, QA, PM, security) directly to your local workspace. It works with OpenCode, Cursor, Claude Code, Gemini, and Codex CLI to write, test, and fix code via a real-time WebSocket bus. 

**Maker Comment (First Comment Draft)**:
Hi Product Hunt! 👋 I'm Jeff, one of the makers of CrewSwarm.

We love tools like GitHub Copilot and Cursor, but we found that a single, generic AI assistant often struggles with complex, multi-step engineering tasks. That's why we built CrewSwarm. 

Instead of a single AI, you get a full engineering team. Need to plan a feature? Assign it to `@crew-pm`. Need to find a bug? Let `@crew-qa` write the tests while `@crew-fixer` applies the patch. They all share the same memory context and communicate over a unified real-time WebSocket bus.

**Key Features**:
🤝 **Multi-Agent Collaboration**: 20+ specialized agents working together.
🔌 **Universal IDE Support**: Seamless execution through OpenCode, Cursor, Claude Code, Gemini, and Codex CLI.
🧠 **Shared Memory**: Zero context loss between Cursor sessions or dashboard chats.
🔒 **Self-Hosted & Multi-Provider**: Use Gemini, Grok, OpenAI, Kimi, Opencode, Perplexity, DeepSeek, Groq, Claude, or run local models. It's completely open-source.

We'd love for you to try it out! We're hanging out in the comments to answer any questions about the multi-agent architecture or how we integrated with various IDEs. 🚀

**Media Needs**:
- ✅ Logo (from website/logo.png)
- [ ] 3-5 high-quality screenshots of the workflow (Vibe IDE, Dashboard, Agent interactions)
- [ ] Demo Video (~2 minutes showing a complex feature request being broken down and executed)
