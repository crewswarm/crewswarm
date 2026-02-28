# OpenClaw reference audit (file-by-file)

Counts and brief notes. Run from repo root: `grep -ri openclaw --include='*.mjs' --include='*.sh' --include='*.ts' --include='*.md' --include='*.html' --include='*.json' --include='*.css' . -c` (excludes .git).

## Code (scripts and core)

| File | Count | Notes |
|------|-------|--------|
| **scripts/dashboard.mjs** | 82 | Variable `OPENCLAW_DIR` (repo root); config fallback `~/.openclaw`; UI labels "OpenClaw Gateway", "OpenClaw integration"; API `/api/settings/openclaw-status`; device paths `~/.openclaw/devices`; service id `openclaw-gateway`; `OPENCLAW_ALLOWED_AGENTS`; `open -a OpenClaw`; comments. |
| **gateway-bridge.mjs** | 38 | `STATE_DIR = ~/.openclaw`; config/agent/prompt paths fallback to openclaw; comments "OpenClaw", "openclaw.json"; `CREWSWARM_TO_OPENCLAW_AGENT_MAP`; fallback to OpenClaw gateway; ack note "openclaw completed task". |
| **scripts/openswitchctl** | 29 | Env `OPENCLAW_DIR` (default `$HOME/Desktop/CrewSwarm`); `CFG_DIR` default `$HOME/.openclaw`; `openclaw.json`; cmd `restart-openclaw-gateway`; `open -a OpenClaw`; comments. |
| **scripts/crewswarm-test.mjs** | 11 | Sets `OPENCLAW_DIR` for tests; crewswarm.json vs openclaw paths. |
| **contrib/swiftbar/openswitch.10s.sh** | 11 | Menu "OpenClaw", paths, restart OpenClaw app. |
| **scripts/opencrew-rt-daemon.mjs** | 10 | `SHARED_MEMORY_DIR` default `~/.openclaw/workspace/...`; token from config.json or openclaw.json; error message lists both paths. |
| **scripts/start-crew.mjs** | 5 | Variable `OPENCLAW_DIR`; comment "openclaw.json"; config fallback path. |
| **scripts/restart-service.sh** | 5 | Uses OPENCLAW_DIR / openclaw. |
| **pm-loop.mjs** | 4 | Fallback paths `~/.openclaw/search-tools.json`, openclaw.json, agent-prompts. |
| **crew-lead.mjs** | 4 | Fallback reads for search-tools, agent-prompts, openclaw.json (RT token). |
| **install.sh** | 4 | Comments and legacy path mentions. |
| **unified-orchestrator.mjs** | 1 | Variable `OPENCLAW_DIR` only. |
| **scripts/run.mjs** | 1 | Variable `OPENCLAW_DIR`; help text "OpenCrewHQ — Multi-agent orchestration for OpenClaw". |
| **scripts/dlq-replay.mjs** | 1 | Variable `OPENCLAW_DIR` (repo root). |
| **scripts/test-complex-orchestration.mjs** | 1 | Default dir `Desktop/OpenClaw` (wrong for CrewSwarm repo). |
| **scripts/test-delegation.mjs** | 1 | Already CREWSWARM_DIR + Desktop/CrewSwarm per earlier fix. |
| **natural-pm-orchestrator.mjs** | 1 | `process.env.OPENCLAW_DIR` fallback next to CREWSWARM_DIR. |
| **phased-orchestrator.mjs** | 1 | Usage string "OpenCrewHQ". |
| **continuous-build.mjs** | 1 | `process.env.OPENCLAW_DIR` fallback. |
| **crew-cli.mjs** | 1 | Comment or env fallback. |
| **scripts/crew-scribe.mjs** | 2 | Config fallback path; comment. |
| **scripts/sync-agents.mjs** | 3 | Legacy fallback paths and error messages. |
| **telegram-bridge.mjs** | 3 | Legacy fallback; comments. |
| **scripts/crewswarm-flow-test.mjs** | 2 | Paths / env. |
| **scripts/test-pm-direct.mjs** | 1 | One reference. |

## Config / docs / contrib

| File | Count | Notes |
|------|-------|--------|
| **contrib/openclaw-plugin/** | multiple | Plugin *for* OpenClaw; name is correct (openclaw.plugin.json, README, index.ts). |
| **.env.example** | 1 | Legacy mention. |
| **.gitignore** | 1 | Path or comment. |
| **README.md** | 3 | Project readme. |
| **docs/SYSTEM-ARCHITECTURE.md** | 7 | Architecture docs. |
| **docs/OPENCLAW-AGENTS-SETUP.md** | 26 | Legacy agent setup doc. |
| **docs/KEEP-AGENTS-WORKING.md** | 14 | 14 refs. |
| **docs/PHASED-ORCHESTRATOR.md** | 14 | 14 refs. |
| **docs/SETUP-NEW-AGENTS.md** | 18 | 18 refs. |
| **docs/OPENCODE-INTEGRATION-STATUS.md** | 11 | 11 refs. |
| **docs/TROUBLESHOOTING.md** | 9 | 9 refs. |
| **docs/WEBSITE-FEATURES-AND-USE-CASES.md** | 8 | 8 refs. |
| **website/ROADMAP.md** | 9 | 9 refs. |
| **docs/MIGRATION-CREW-IDS.md** | 5 | 5 refs. |
| **docs/MODEL-RECOMMENDATIONS.md** | 4 | 4 refs. |
| **website/index.html** | 4 | 4 refs. |
| **website/styles.css** | 3 | 3 refs. |
| **docs/SESSION-SUMMARY.md** | 3 | 3 refs. |
| **docs/ORCHESTRATOR-GUIDE.md** | 2 | 2 refs. |
| **memory/** (brain, protocol, README, decisions, prompt-snippets) | 8 | Memory/docs. |
| **docs/SCRIPTS.md** | 1 | 1 ref. |
| **docs/OPENAI-CHATGPT-VS-API.md** | 1 | 1 ref. |
| **demo/index.html** | 2 | 2 refs. |
| **scripts/restart-all-from-repo.sh** | 1 | 1 ref. |
| **contrib/swiftbar/README.md** | 1 | 1 ref. |

## Summary

- **Rename variable**: In dashboard, openswitchctl, start-crew, unified-orchestrator, run.mjs, dlq-replay: use `CREWSWARM_DIR` (and in shell `CREWSWARM_DIR`) where it means “repo root”; keep `OPENCLAW_DIR` only as legacy env fallback if desired.
- **Config paths**: All “read config” code already prefers `~/.crewswarm/`; remaining `~/.openclaw/` are intentional fallbacks or RT shared-memory default path.
- **UI/strings**: Dashboard and swiftbar: “OpenClaw Gateway” → “Legacy gateway” or similar; optional “OpenClaw” app launch can stay for users who have it.
- **Tests**: test-complex-orchestration default dir should be CrewSwarm (e.g. `Desktop/CrewSwarm` or `__dirname`), not `Desktop/OpenClaw`.
- **Docs**: Update or archive OPENCLAW-*.md and other docs to say CrewSwarm-first and OpenClaw as optional/legacy.
- **contrib/openclaw-plugin**: No change; name is correct for the OpenClaw plugin.
