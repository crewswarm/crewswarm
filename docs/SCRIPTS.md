# Scripts Reference

**Last Updated:** 2026-02-26

> **Primary interface:** The web dashboard (`npm run start` → `http://127.0.0.1:4319`) and the Chat tab are the main way to use CrewSwarm. The scripts below are for CLI power users, automation, and troubleshooting.

---

## Core services

| Script | npm script | Purpose |
|--------|-----------|---------|
| `scripts/dashboard.mjs` | `npm start` | Web dashboard + API server on :4319 |
| `crew-lead.mjs` | — | Conversational commander + REST API on :5010 |
| `gateway-bridge.mjs` | — | Per-agent daemon — bridges RT bus ↔ LLM API |
| `scripts/opencrew-rt-daemon.mjs` | — | Realtime message bus on :18889 |
| `scripts/mcp-server.mjs` | `npm run mcp` | MCP + OpenAI-compatible API on :5020 |

**Start everything:**
```bash
npm run restart-all
# or
bash scripts/restart-all-from-repo.sh
```

---

## Agent management

| Script | Purpose |
|--------|---------|
| `scripts/start-crew.mjs` | Start / stop all agent gateway-bridge daemons |
| `scripts/sync-agents.mjs` | Sync agent list from `~/.crewswarm/crewswarm.json` to dashboard |
| `scripts/sync-prompts.mjs` | Sync agent system prompts to `~/.crewswarm/agent-prompts.json` |

---

## CLI orchestration (scripted builds)

These are for running multi-agent pipelines from the command line without the dashboard.

| Script | Purpose |
|--------|---------|
| `scripts/run.mjs "requirement"` | Run `unified-orchestrator.mjs` with a natural-language requirement |
| `unified-orchestrator.mjs` | Full orchestration: PM plan → parser → JSON → workers → verification |
| `natural-pm-orchestrator.mjs` | Simpler: PM plan → regex parse → dispatch (good for quick tasks) |
| `phased-orchestrator.mjs` | Phased build loop (also used by dashboard Build tab) |
| `continuous-build.mjs` | Continuous autonomous build against a roadmap |
| `crew-cli.mjs` | CLI wrapper: `node crew-cli.mjs "Build X"`, `--status`, `--history` |
| `scripts/run-scheduled-pipeline.mjs` | Run a saved pipeline JSON on a schedule (cron-friendly) |

---

## Health and diagnostics

| Script | npm script | Purpose |
|--------|-----------|---------|
| `scripts/health-check.mjs` | `npm run health` | Fast check of all services, agents, and MCP |
| `scripts/check-dashboard.mjs` | — | Validate dashboard HTML/inline script (run after editing `dashboard.mjs`) |
| `scripts/check-telemetry.mjs` | — | Check OPS telemetry pipeline |
| `scripts/dlq-replay.mjs` | — | Replay failed tasks from the dead-letter queue |

---

## Testing

| Script | npm script | Purpose |
|--------|-----------|---------|
| `scripts/crewswarm-flow-test.mjs` | `npm run smoke` | End-to-end smoke test — stack health + dispatch flow |
| `scripts/test-mcp.mjs` | `npm run test:mcp` | MCP server handshake + tool call tests |
| `scripts/test-classifier.mjs` | `npm run test:classifier` | Task complexity classifier unit + E2E tests |
| `scripts/smoke-dispatch.mjs` | — | Quick dispatch smoke test |
| `scripts/test-dispatch.mjs` | — | Dispatch round-trip test |
| `scripts/test-delegation.mjs` | — | Tests targeted `--send` delegation to specific agents |
| `scripts/test-complex-orchestration.mjs` | — | Multi-agent orchestration end-to-end test |
| `scripts/test-pipeline-quality.mjs` | — | Pipeline output quality checks |
| `scripts/model-speed-test.mjs` | — | Benchmark model response latency |
| `scripts/fresh-machine-smoke.sh` | — | Clean-install verification on a fresh machine |

---

## Memory and scribe

| Script | Purpose |
|--------|---------|
| `scripts/crew-scribe.mjs` | Memory maintenance: summaries, lessons, brain.md updates |
| `scripts/scan-skills.mjs` | Scan and list installed skills in `~/.crewswarm/skills/` |

---

## SwiftBar / macOS menu bar

| Script | Purpose |
|--------|---------|
| `scripts/openswitch.10s.sh` | SwiftBar plugin — system status in menu bar (copy to `~/Library/Application Support/SwiftBar/Plugins/`) |
| `scripts/restart-service.sh` | Helper called by SwiftBar to restart individual services |
| `scripts/restart-all-from-repo.sh` | Full restart of all services from the repo |
