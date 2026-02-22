# Scripts Overview

**Last Updated:** 2026-02-20

## Entrypoint

| Script | Purpose |
|--------|---------|
| `scripts/run.mjs` | Canonical entrypoint. Runs unified-orchestrator with your requirement: `node scripts/run.mjs "requirement"` |

## Main Scripts

| Script | Purpose |
|--------|---------|
| `unified-orchestrator.mjs` | Full orchestration: PM plan → parser → JSON → gateway-bridge --send to workers → verification |
| `natural-pm-orchestrator.mjs` | Simpler variant: PM plan → regex parse → gateway-bridge --send (good for quick tasks) |
| `gateway-bridge.mjs` | Bridges OpenCrew RT ↔ OpenClaw Gateway. Use `--send <agent> "task"` for targeted dispatch, `--status`, `--history`, etc. |
| `crew-cli.mjs` | CLI wrapper: `crew "Build X"`, `crew code/test/fix/audit "task"`, `crew --status` |

## Test Scripts

| Script | Purpose |
|--------|---------|
| `scripts/test-delegation.mjs` | Tests targeted send (--send) to specific agents |
| `scripts/test-complex-orchestration.mjs` | End-to-end test of complex multi-task orchestration |
| `scripts/test-pm-curl.sh` | Curl-based test of PM/parser flow |
| `scripts/test-pm-direct.mjs` | Direct PM call test (no RT) |
| `scripts/model-speed-test.mjs` | Benchmark model response times |

## When to Use What

- **User says "build X"** → `node crew-cli.mjs "build X"` or `node scripts/run.mjs "build X"`
- **Single task to one agent** → `node gateway-bridge.mjs --send crew-coder "Create server.js with Express"`
- **Check status** → `bash ~/bin/openswitchctl status` or `node crew-cli.mjs --status`
- **Start all agent bridges** → `node scripts/start-crew.mjs`
- **Test delegation** → `node scripts/test-delegation.mjs`
