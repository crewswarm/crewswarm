# Orchestration Protocol

**Last Updated:** 2026-02-26

> The canonical orchestration reference is **[AGENTS.md](../AGENTS.md)** at the repo root. It covers: agent roster, coordinator roles, dispatch format, tool syntax, pipeline DSL, pipeline waves, and tool permissions per agent.

---

## Quick reference

### Dispatch a task to one agent

```
@@DISPATCH {"agent":"crew-coder","task":"Write /src/auth.ts — JWT login endpoint"}
```

### Pipeline — sequential waves, parallel within a wave

```
@@PIPELINE [
  {"wave":1, "agent":"crew-coder",    "task":"Write /src/auth.ts"},
  {"wave":1, "agent":"crew-coder",    "task":"Write /src/auth.test.ts"},
  {"wave":2, "agent":"crew-qa",       "task":"Audit /src/auth.ts"},
  {"wave":3, "agent":"crew-github",   "task":"Commit changes to git"}
]
```

### Stop everything

```
stop everything    → graceful (pipelines cancelled, PM loops finish current task)
kill everything    → hard kill (all agent bridges SIGTERM'd immediately)
```

### Agent tool markers

```
@@WRITE_FILE /path/to/file.js
...content...
@@END_FILE

@@READ_FILE /path/to/file.js
@@MKDIR /path/to/dir
@@RUN_CMD npm install          # gated by cmd-allowlist.json
@@DISPATCH {"agent":"...","task":"..."}
```

---

## Full reference

See **[AGENTS.md](../AGENTS.md)** for:
- Complete agent roster and coordinator responsibilities
- Tool permissions per agent (`crewswarmAllow`)
- How to add new agents and change models
- PM loop, scheduled pipelines, and background consciousness
- External API (`GET /api/agents`, `POST /api/dispatch`, `GET /api/status/:taskId`)
