# Phased Orchestrator

**Last Updated:** 2026-02-26

---

## What it does

The phased orchestrator breaks large requirements into sequential phases (MVP → Phase 1 → Phase 2), dispatching each phase as a small set of 3–5 focused tasks. This avoids PM timeouts on complex requirements and produces cleaner, auditable builds.

## Usage

### From the dashboard Chat tab

```
Build a SaaS dashboard with auth, billing, and reports — phase it out
```

crew-lead + crew-pm will plan phases automatically. Each phase runs as a `@@PIPELINE` wave.

### From the PM Loop (autonomous mode)

```bash
# Start PM loop — reads ROADMAP.md, dispatches tasks until done
PM_ROADMAP_FILE=./ROADMAP.md OPENCREW_OUTPUT_DIR=./output node pm-loop.mjs
```

### Via API

```bash
TOKEN=$(cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")

curl -X POST http://127.0.0.1:5010/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crew-pm","task":"Phase this requirement into MVP + Phase 1 + Phase 2: Build a user auth API with tests"}'
```

---

## Pipeline DSL (@@PIPELINE)

crew-lead (or any agent) can emit a pipeline directly:

```
@@PIPELINE [
  {"wave":1, "agent":"crew-coder", "task":"Write /src/auth.ts — JWT login endpoint"},
  {"wave":1, "agent":"crew-coder", "task":"Write /src/auth.test.ts — unit tests"},
  {"wave":2, "agent":"crew-qa",    "task":"Audit /src/auth.ts for security issues"},
  {"wave":2, "agent":"crew-fixer", "task":"Apply any fixes from QA report"}
]
```

Tasks in the same `wave` run in parallel. Higher waves wait for all lower waves to complete. Pipeline state is saved and auto-resumed if crew-lead restarts.

---

## Stop / cancel

| Command | Effect |
|---|---|
| `"stop everything"` in chat | Graceful stop — cancels pending waves, signals PM loops to finish current task |
| `"kill everything"` in chat | Hard stop — cancels waves + SIGTERMs all agent bridges immediately |

---

## Output

By default agents write to the path specified in each task. Override the base output path with `OPENCREW_OUTPUT_DIR`:

```bash
OPENCREW_OUTPUT_DIR=/tmp/my-build npm run restart-all
```

---

## Troubleshooting

**PM timeouts** — if crew-pm times out on large requirements, break the requirement into phases yourself and dispatch each phase separately.

**Agent not picking up tasks** — run `npm run health` to check all bridges are connected. Use `@@SERVICE restart agents` in chat to respawn bridges.

**Pipeline stuck at wave N** — if an agent in the current wave is offline, the wave never completes. Restart the missing agent from the Services tab or say `@@SERVICE restart <agent-id>` in chat.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for more.
