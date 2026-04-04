# crew-cli Features

crew-cli is the terminal interface for crewswarm. It provides 45+ built-in tools, 6 LLM providers, 7 execution engines, and a tiered autonomy system that controls how much the agent can do without approval.

---

## Tiered Autonomy (L1/L2/L3)

crew-cli uses a three-tier system to control tool access:

| Tier | Tools | Purpose |
|------|-------|---------|
| **L1** | 0 | Chat only. No file access, no shell. Safe for questions and explanations. |
| **L2** | 7 (read-only) | Planning mode. Can read files, search code, inspect git state. Cannot write or execute. |
| **L3** | 45+ | Full execution. File I/O, shell, git, Docker, sub-agents, web access, everything. |

Configure per-tier models with `/stack`:
```
/stack L1 gemini-2.5-flash
/stack L2 gpt-5.2
/stack L3 claude-opus-4
```

L2 generates plans; L3 executes them. L1 handles conversational queries at minimal cost.

---

## LLM Providers

6 providers, all with streaming support. OAuth-first with API key fallback.

| Provider | OAuth Source | API Key Env Var |
|----------|-------------|-----------------|
| **Anthropic** | Claude Pro subscription (CCH signing) | `ANTHROPIC_API_KEY` |
| **OpenAI** | Codex CLI (`~/.codex/auth.json`) | `OPENAI_API_KEY` |
| **Google** | Google account ADC | `GEMINI_API_KEY` |
| **xAI** | -- | `XAI_API_KEY` / `GROK_API_KEY` |
| **DeepSeek** | -- | `DEEPSEEK_API_KEY` |
| **Groq** | -- | `GROQ_API_KEY` |

OAuth tokens are discovered automatically. If a valid OAuth token exists, the API key is not needed. This means users with Claude Pro, Cursor Pro, or a Google account can use crew-cli at zero marginal cost for those providers.

---

## Execution Engines

7 engines for running tasks. crew-cli can dispatch to any of them:

1. **Direct API** -- Raw provider API calls. Most flexible, works with all 6 providers.
2. **crew-cli native** -- Built-in tool loop with 45+ tools. Default for L3 tasks.
3. **Claude Code CLI** -- Subprocess wrapper. Uses Claude's own tool implementation.
4. **Codex CLI** -- OpenAI's CLI agent. SSE streaming, `store:false` for privacy.
5. **Gemini CLI** -- Google's CLI agent. 2M token context, OAuth free tier.
6. **Cursor CLI** -- Cursor's agent mode. Requires Cursor installation.
7. **OpenCode** -- Multi-model CLI. HTTP dispatch or subprocess.

Select an engine explicitly with `--engine`:
```bash
crew chat "refactor auth" --engine claude-code
crew chat "add tests" --engine codex
```

---

## Built-in Tools (45+)

L3 mode exposes the full tool set:

**File I/O:** read_file, write_file, edit_file, list_directory, glob, grep, file_search

**Shell:** bash, pty (interactive terminal)

**Git:** git_status, git_diff, git_log, git_commit, git_checkout, git_stash

**LSP:** lsp_check (TypeScript diagnostics), lsp_complete (autocomplete suggestions)

**Jupyter:** notebook_read, notebook_edit, notebook_run

**Web:** web_search, web_fetch

**Docker:** docker_sandbox (isolated execution environment)

**Memory:** memory_recall, memory_record (AgentKeeper cross-session persistence)

**Sub-agents:** spawn_agent (returns session_id), agent_message (multi-turn follow-ups)

**Worktree:** worktree_create, worktree_switch (git worktree isolation for parallel agents)

**Misc:** sleep, tool_search (JIT tool discovery), task_tracker

All tool calls display a gray activity line before execution so you can see what the agent is doing.

---

## REPL

Interactive mode with ghost-text autocomplete (Fish/zsh-style predictive suggestions).

```bash
crew repl
```

Built-in commands:
- `/help` -- Show commands
- `/stack` -- Configure L1/L2/L3 models
- `/model` -- Switch active model
- `/lsp` -- LSP diagnostics
- `/memory` -- Query AgentKeeper
- `/preview` -- Show pending sandbox changes
- `/apply` -- Write sandbox changes to disk
- `/rollback` -- Discard pending changes
- `/cost` -- Show token usage and USD spent
- `/mode [manual|assist|autopilot]` -- Set autonomy level. `Shift+Tab` cycles modes.

---

## Context Management

Three mechanisms keep the context window useful:

1. **Token compaction** -- When conversation exceeds the model's context limit, older messages are summarized and replaced with a compact representation.

2. **RAG** -- TF-IDF + embeddings over the codebase. Relevant files are injected automatically based on the current query. `crew docs <query>` searches project documentation explicitly.

3. **JIT discovery** -- `tool_search` finds relevant tools on demand rather than stuffing all 45+ tool definitions into every prompt.

---

## Session Persistence

Sessions are stored as JSONL for crash safety. If crew-cli is killed mid-conversation, `crew repl --resume` picks up where it left off. Sessions are keyed by `(engine, projectDir, sessionId)` so multiple chats against the same project do not interfere.

---

## Cost Tracking

Every API call is logged with token counts and USD cost. `crew cost` shows the running total. Budget enforcement stops execution when a `--budget` limit is hit:

```bash
crew auto "fix all lint errors" --budget 0.50
```

---

## Post-Sampling Hooks

After the LLM produces a response, crew-cli can run automatic checks before applying changes:

- **Lint hook** -- Runs the project linter on modified files. Rejects changes that introduce new warnings.
- **Auto-commit hook** -- Commits applied changes with a generated message.
- **File-size guard** -- Rejects writes that would create files above a configurable size threshold.

---

## Sub-Agents

`spawn_agent` creates a sub-agent session and returns a `session_id`. `agent_message` sends follow-up messages to that session. This enables multi-turn delegation:

```
spawn_agent("crew-qa", "write integration tests for auth") -> session_id
agent_message(session_id, "also cover the password reset flow")
```

Sub-agents run in their own context and can be dispatched in parallel. The orchestrator merges results.

---

## Git Worktree Isolation

For parallel agent work, crew-cli creates git worktrees so each agent operates on an isolated branch without interfering with the working directory:

```bash
crew auto "refactor auth" --worktree
```

The agent works in a temporary worktree. Changes are merged back on completion.

---

## AgentKeeper Memory

Cross-session semantic memory stored in `.crew/agentkeeper.jsonl`. The agent records facts, decisions, and corrections. On future sessions, relevant memories are recalled automatically via semantic similarity with deduplication.

```bash
crew memory "what did we decide about the auth schema?"
crew memory-compact   # deduplicate and prune stale entries
```

Disable with `--no-memory`. Limit injection with `--memory-max <n>`.

---

## Doctor Diagnostics

`crew doctor` runs 10 provider health checks to verify that API keys, OAuth tokens, and CLI installations are working:

```bash
crew doctor
# Anthropic API key ... OK (claude-sonnet-4-20250514)
# Anthropic OAuth  ... OK (CCH signed, expires 2026-04-05)
# OpenAI API key   ... OK (gpt-5.2)
# OpenAI OAuth     ... OK (~/.codex/auth.json)
# Gemini API key   ... OK (gemini-2.5-flash)
# Gemini OAuth     ... OK (ADC)
# xAI API key      ... OK (grok-4)
# DeepSeek API key ... OK (deepseek-chat)
# Groq API key     ... OK (llama-4-scout)
# Claude Code CLI  ... OK (v1.x installed)
```

---

## Multimodal Vision

Pass images directly into conversation:

```bash
crew chat "what's wrong with this UI?" --image screenshot.png
```

Supports PNG, JPG, WebP, GIF. Images are resized to fit within `--image-max-bytes` before sending.

---

## Comparison With Other Coding CLIs

Based on publicly documented features as of April 2026.

| Feature | Claude Code | Codex CLI | Gemini CLI | Cursor CLI | OpenCode | **crew-cli** |
|---------|------------|-----------|------------|------------|----------|--------------|
| Multi-provider | No (Anthropic) | No (OpenAI) | No (Google) | Yes | Yes | **Yes (6)** |
| OAuth token reuse | Yes | Yes | Yes | Yes | No | **Yes (all)** |
| Tool count | ~15 | ~10 | ~15 | ~15 | ~10 | **45+** |
| Tiered autonomy (L1/L2/L3) | No | No | No | No | No | **Yes** |
| Multi-turn sub-agents | No | No | No | No | No | **Yes** |
| Git worktree isolation | No | No | No | No | No | **Yes** |
| Ghost-text autocomplete | No | No | Yes | No | No | **Yes** |
| Cross-session memory | No | No | No | No | No | **Yes** |
| Cost budget enforcement | No | No | No | No | No | **Yes** |
| Post-sampling hooks | No | No | No | No | No | **Yes** |
| Crash-safe session resume | Yes | No | Yes | No | No | **Yes** |
| Docker sandbox | No | Yes | No | No | No | **Yes** |
| LSP integration | No | No | No | Yes (IDE) | No | **Yes** |
| Jupyter notebooks | No | No | No | No | No | **Yes** |

---

## Additional Commands

```bash
crew chat "<prompt>"              # One-shot query
crew auto "<task>"                # Autonomous loop with iteration limit
crew plan "<task>"                # Generate step-by-step plan (L2), then execute (L3)
crew dispatch <agent> "<task>"    # Send task to a specific agent
crew config show                  # Show resolved config (team + user layers)
crew github "<natural language>"  # GitHub operations via gh with confirmation gates
crew map --graph                  # Repository dependency graph
crew x-search "<query>"          # X/Twitter search via xAI
crew autofix enqueue "<task>"     # Queue background auto-fix job
crew autofix worker               # Run background job processor
crew shell "<description>"        # Natural language to shell command
crew docs "<query>"               # RAG search over project docs
crew checkpoint list              # List resumable execution checkpoints
```

---

**Last updated:** 2026-04-04
**Maintained by:** crewswarm team
