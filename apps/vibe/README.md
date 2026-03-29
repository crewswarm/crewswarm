# crewswarm Vibe

Local coding surface for crewswarm with:

- real local project persistence
- real file read/write through the local server
- Monaco editor
- local `cli:codex` execution
- optional dashboard / RT integrations when the broader stack is running

## Start

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:3333`.

## What Is Local vs Shared

Local Vibe owns:

- projects via `server.mjs`
- file listing / read / write
- local project chat history
- `cli:codex` execution

Optional crewswarm services add:

- `crew-lead` / agent chat via dashboard APIs
- RT activity stream
- agent roster loading

If the dashboard stack is offline, local coding still works.

## Scripts

```bash
npm run dev
npm run build
npm start
npm run test
npm run test:e2e
npm run perf:analyze
npm run perf:audit
```

`npm run test` runs the standalone smoke, accessibility, performance, and security checks.
`npm run test:e2e` runs a self-contained local HTTP/API end-to-end check for the shipped Vibe bundle and server routes.

## Performance Tooling

Use `npm run perf:analyze` from `apps/vibe/` to generate a profile-aware load report against the local Vibe server. The underlying tooling lives at `../../scripts/bench/performance_optimization.py` and `../../scripts/bench/load_testing.py`, so you can also run a direct `py-spy` capture when you need CPU-level evidence:

```bash
python3 ../../scripts/bench/load_testing.py \
  --url http://127.0.0.1:3333/ \
  --requests 40 \
  --concurrency 4 \
  --profile-command "npm start" \
  --profile-output /tmp/crewswarm-vibe.speedscope.json
```

Use `npm run perf:audit` for a browser-level audit of the shipped Vibe bundle. It boots the local Vibe server on an isolated port, captures navigation timing, transfer size, long tasks, and heap usage through Playwright + the browser Performance APIs, then writes a report to `apps/vibe/output/performance-audit.json`.

Vibe’s local server now caches workspace scans and audit file samples for a few seconds, then invalidates those caches on project updates and file writes. That keeps the file explorer and audit endpoints responsive without hiding fresh edits.

## Current Boundaries

- `cli:codex` is the supported standalone CLI path.
- `Cmd/Ctrl+K` inline chat uses the same local Codex path as the main chat when `cli:codex` is selected.
- Other CLI passthrough modes still depend on the dashboard backend.
- The bottom terminal panel now runs through a PTY-backed local shell in the selected project directory, including live resize support from the embedded terminal.
- `cli:*` chat keeps the assistant answer in the chat bubble and sends raw execution trace output to the Activity Trace panel.
