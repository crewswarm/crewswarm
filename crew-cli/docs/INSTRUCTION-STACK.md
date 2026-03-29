# crew-cli Instruction Stack

This is the canonical explanation of how `crew-cli` composes instructions at runtime.

## Precedence

Highest priority wins when instructions conflict.

1. User prompt
2. Explicit CLI flags for the current run
3. Session-scoped REPL state
4. Project policy files in the current repo
5. Shared user config in `~/.crewswarm/crewswarm.json`
6. Activated skills and context packs
7. Built-in runtime prompts and tool policies

## Layers

### 1. User prompt

The current task defines the immediate goal.

Examples:

- `crew chat "fix auth tests"`
- `crew run -t "build settings page"`
- REPL input in `crew repl`

### 2. Explicit CLI flags

Flags override defaults for the current invocation only.

Examples:

- `--model gpt-5.4`
- `--engine codex`
- `--always-approve`
- `--preset quality`
- `--legacy-router`

### 3. Session-scoped REPL state

REPL changes apply to the current session unless persisted elsewhere.

Examples:

- `/model gpt-5.4`
- `/engine crew-cli`
- `/mode assist`
- `/stack router grok`

### 4. Project policy files

Repo-local policy shapes behavior for the current codebase.

Main files:

- `.crew/model-policy.json`
- `AGENTS.md`
- other repo docs loaded through RAG or tool reads

### 5. Shared user config

Persistent cross-project defaults live in:

- `~/.crewswarm/crewswarm.json`

This includes provider keys, agent model assignments, and runtime defaults.

### 6. Skills and context packs

Skills inject specialized task guidance.

Sources:

- `~/.crewswarm/skills/*.json`
- `~/.crewswarm/skills/**/SKILL.md`

### 7. Built-in runtime prompts and tool policies

The runtime has built-in guidance for:

- orchestration
- routing
- tool use
- sandbox behavior
- repair/fallback logic

## Mental model

- user says what to do
- flags/session state choose how to run it
- project policy says how this repo should behave
- shared config provides persistent defaults
- skills refine execution
- built-in runtime prompts make the engine operate safely

## Related docs

- [OVERVIEW.md](./OVERVIEW.md)
- [PERMISSIONS-MODEL.md](./PERMISSIONS-MODEL.md)
- [REPL-MODES-AND-RELIABILITY.md](./REPL-MODES-AND-RELIABILITY.md)
