# Shared Memory & Team Sync

`crew-cli` features a multi-layered memory system designed for cognitive continuity across sessions, models, and teams.

## 🧠 Memory Layers

### 1. AgentKeeper (Task Memory)
Stores the results of every task executed by the crew in a local, append-only JSONL store (`.crew/agentkeeper.jsonl`).
- **Purpose**: Allows agents to "remember" how they solved a specific problem in the past.
- **Retrieval**: Uses lexical similarity scoring to find the most relevant prior tasks.
- **Commands**: 
  - `crew memory "search query"`: Manually recall prior task results.
  - `crew memory-compact`: Compact the store and deduplicate entries.

### 2. AgentMemory (Cognitive Facts)
A persistence layer for "facts" that models should keep in mind across different execution tiers.
- **Purpose**: Continuity for high-level decisions, architecture choices, and critical constraints.
- **Priority**: Supports "CRITICAL" flags to ensure certain facts always stay within the token budget.
- **Storage**: Can be shared across systems using the `CREW_MEMORY_DIR` environment variable.

### 3. Local RAG (Collections Search)
Indexes your local `docs/` folder and markdown files to ground agent responses in your project's specific documentation.
- **Commands**:
  - `crew docs "how to deploy"`: Search local documentation.
  - Used automatically when the `--docs` flag is passed to `chat` or `dispatch`.

---

## 🤝 Team Synchronization (`crew sync`)

The `sync` system allows engineering teams to share AI "experience" without sharing sensitive code.

### How it works
1. **Upload**: `crew sync --upload` packages your local session history and AI correction patterns.
2. **Privacy**: Before upload, entries are filtered through `.crew/privacy.json`. You can choose to redact prompts, original code, or tags.
3. **Storage**: Data is stored in a shared team directory (often a git-ignored folder in a shared repo) or a centralized S3 bucket.
4. **Download**: `crew sync --download` pulls team-wide corrections and merges them into your local AgentKeeper, allowing you to benefit from your teammates' AI interactions.

### Environment Variables for Teams
- `TEAM_SYNC_DIR`: Path to a shared folder (e.g., a Dropbox or mounted drive).
- `TEAM_S3_SESSION_PUT_URL` / `GET_URL`: Pre-signed S3 URLs for cloud-based team sync.

---

## 🏗️ The Memory Broker

The `MemoryBroker` is the internal engine that unifies all the above sources. When an agent is dispatched with memory enabled, the broker:
1. Lexically searches **AgentKeeper** for similar tasks.
2. Retrieves high-priority facts from **AgentMemory**.
3. Optionally pulls relevant chunks from your **Docs Collection**.
4. Merges and ranks them into a single `## Shared Memory + RAG Context` block injected into the prompt.

This ensures the agent has the collective "brain" of both your past work and your team's expertise.
