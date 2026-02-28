# OpenClaw refs — 1-by-1 review

## 1. gateway-bridge.mjs (38 refs)

| Line | Current | Verdict | Change |
|------|--------|--------|--------|
| 18 | `STATE_DIR = path.join(os.homedir(), ".openclaw")` | Rename for clarity | Use `LEGACY_STATE_DIR` or keep; it's only used for fallback openclaw.json path. |
| 38 | Comment: crewswarm first, ~/.openclaw fallback | OK | Comment is accurate. |
| 40 | `path.join(STATE_DIR, "openclaw.json")` | OK | Fallback path. |
| 93 | read openclaw.json from STATE_DIR | OK | Fallback. |
| 119 | Comment "Auto-load agents from openclaw.json" | Cosmetic | "from crewswarm.json / openclaw.json (legacy)". |
| 139 | Comment "extra agents in openclaw.json" | Cosmetic | "in crewswarm.json or openclaw.json (legacy)". |
| 141 | cfgPath = ~/.openclaw/openclaw.json | OK | Fallback. |
| 166 | `CREWSWARM_TO_OPENCLAW_AGENT_MAP` | OK or rename | Maps RT agent id → gateway agent id; could rename to `RT_TO_GATEWAY_AGENT_MAP`. |
| 169 | Comment "bypasses OpenClaw" | Cosmetic | "bypasses legacy gateway". |
| 171 | Comment "falls back to openclaw.json" | OK | Accurate. |
| 175, 192, 903 | path ~/.openclaw/openclaw.json | OK | Fallbacks. |
| 187 | Comment openclaw.json models.providers | OK | Accurate. |
| 236 | Comment "fall through to OpenClaw" | Cosmetic | "fall through to legacy gateway". |
| 892 | Comment "distinct from OpenClaw tool names" | Cosmetic | "distinct from legacy gateway tool names". |
| 897, 912 | Comment OpenClaw tool names | Cosmetic | "legacy gateway tool names". |
| 1164, 1175, 1176 | Comments OpenClaw gateway | Cosmetic | "legacy gateway". |
| 1649–1650 | openclaw.json in hint, "initialize OpenClaw first" | Fix | "initialize config (e.g. install) so config exists under ~/.crewswarm or legacy path." |
| 1805 | path ~/.openclaw/agent-prompts.json | OK | Fallback. |
| 1938, 1941 | Comment and path openclaw.json | OK | Fallback. |
| 2327 | note "OpenClaw bridge supports..." | Cosmetic | "Legacy bridge supports...". |
| 2470, 2485–2486, 2493 | OpenClaw in progress/error messages | Cosmetic | "legacy gateway". |
| 2471, 2479, 3003 | `CREWSWARM_TO_OPENCLAW_AGENT_MAP`, openclawAgentId, ocAgentId | OK | Variable names; could rename map to RT_TO_GATEWAY_AGENT_MAP. |
| 2478 | Comment "from openclaw.json" | OK | Accurate. |
| 2623 | note: "openclaw completed task" | Cosmetic | "task completed" or "gateway completed task". |
| 2984 | Comment "OpenCode instead of OpenClaw Gateway" | Cosmetic | "OpenCode instead of legacy gateway". |

---

## 2. scripts/openswitchctl (29 refs)

| Line | Current | Verdict | Change |
|------|--------|--------|--------|
| 2 | Comment "OpenClaw integration" | Cosmetic | "CrewSwarm control script for RT bus, agents, and optional legacy gateway." |
| 4 | "OPENCLAW_DIR set to CrewSwarm repo root" | Fix | "CREWSWARM_DIR or OPENCLAW_DIR (legacy) set to repo root" |
| 8 | `OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/Desktop/CrewSwarm}"` | Optional | Prefer CREWSWARM_DIR, fallback OPENCLAW_DIR; default $HOME/Desktop/CrewSwarm. |
| 9 | `CFG_DIR="${OPENCREWHQ_CONFIG_DIR:-$HOME/.openclaw}"` | Fix | Default to $HOME/.crewswarm; fallback .openclaw for legacy. |
| 10 | `CFG="$CFG_DIR/openclaw.json"` | OK | After CFG_DIR fix, we still need to look for crewswarm.json first then openclaw.json. |
| 16–17, 27 | OPENCLAW_DIR resolution | Optional | Rename to CREWSWARM_DIR with OPENCLAW_DIR fallback. |
| 34–35, 136, 141, 145, 166, 176, 186, 201–202, 225, 242 | Uses of $OPENCLAW_DIR | OK if we rename var | All mean "repo root". |
| 43 | Comment "crewswarm config.json or openclaw.json" | OK | Accurate. |
| 58 | cfg fallback openclaw.json | OK | Legacy. |
| 189–196 | restart-openclaw-gateway, open -a OpenClaw | OK | Keeps working for users with OpenClaw app; label in UI already changed. |
| 263, 277 | restart-openclaw in usage | OK | Subcommand name; keep for backward compat or add restart-legacy-gateway alias. |

---

## 3. scripts/crewswarm-test.mjs (11 refs)

| Line | Current | Verdict | Change |
|------|--------|--------|--------|
| 61, 73 | join(homedir(), ".openclaw", "openclaw.json") | OK | Test checks both crewswarm and openclaw paths. |
| 93 | "No config found in ~/.crewswarm/ or ~/.openclaw/" | OK | Error message accurate. |
| 99, 103–104, 107–108 | ocPath, "openclaw.json agents" | OK | Tests legacy path; messages could say "config (crewswarm.json or openclaw.json)". |
| 240 | OPENCLAW_DIR: REPO in env | Optional | Add CREWSWARM_DIR: REPO; keep OPENCLAW_DIR for compat. |
| 265 | ocPath | OK | Legacy path. |
| 296 | logPath ~/.openclaw/workspace/... | OK | Shared-memory default path. |

---

## 4. contrib/swiftbar/openswitch.10s.sh (11 refs)

| Line | Current | Verdict | Change |
|------|--------|--------|--------|
| 4 | OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/Desktop/CrewSwarm}" | Optional | CREWSWARM_DIR first, OPENCLAW_DIR fallback. |
| 7–8, 14, 129–132, 136, 142, 150 | Uses of OPENCLAW_DIR | OK | All mean repo root. |
| 131 | "OpenCode Server" | OK | Product name. |
| 142 | "Open CrewSwarm Repo" | OK | Label. |

---

## 5. scripts/opencrew-rt-daemon.mjs (10 refs)

| Line | Current | Verdict | Change |
|------|--------|--------|--------|
| 18 | DEFAULT_ALLOWED_AGENTS includes "openclaw", "openclaw-main" | OK | Agent IDs; keep for compat. |
| 19 | OPENCLAW_ALLOWED_AGENTS env | OK | Legacy env name; keep. |
| 23–24 | OPENCLAW_API_KEY, OPENCLAW_REQUIRE_API_KEY | OK | Legacy env; keep. |
| 79 | Error "OPENCLAW_API_KEY is required" | Cosmetic | "API key required (OPENCLAW_API_KEY or CREWSWARM_API_KEY)". |
| 230–231 | agentId === "openclaw-main", startsWith "openclaw" | OK | Agent ID normalization. |
| 463 | Comment "~/.crewswarm or ~/.openclaw" | OK | Accurate. |
| 467 | path join(home, ".openclaw", "openclaw.json") | OK | Fallback. |
| 479 | Error message list both paths | OK | Already says crewswarm first, openclaw second. |

---

## 6. scripts/start-crew.mjs (5 refs)

| Line | Current | Verdict | Change |
|------|--------|--------|--------|
| 16 | CREWSWARM_DIR = CREWSWARM_DIR \|\| OPENCLAW_DIR \|\| cwd | OK | Already prefers CREWSWARM_DIR. |
| 20 | Comment "3. ~/.openclaw/openclaw.json" | OK | Documents fallback. |
| 23 | OPENCLAW_CFG = ~/.openclaw/openclaw.json | OK | Legacy path constant. |
| 29, 39 | OPENCLAW_CFG usage | OK | Fallback. |

---

## Summary

- **gateway-bridge.mjs**: Mostly comments and one hint string; optional rename STATE_DIR → LEGACY_STATE_DIR, CREWSWARM_TO_OPENCLAW_AGENT_MAP → RT_TO_GATEWAY_AGENT_MAP.
- **openswitchctl**: Prefer CREWSWARM_DIR with OPENCLAW_DIR fallback; default CFG_DIR to ~/.crewswarm; keep restart-openclaw-gateway behavior.
- **crewswarm-test.mjs**: All OK (test both paths); optional message tweaks.
- **openswitch.10s.sh**: Optional CREWSWARM_DIR with OPENCLAW_DIR fallback.
- **opencrew-rt-daemon.mjs**: All OK (agent IDs, env names, fallback path).
- **start-crew.mjs**: All OK (already CREWSWARM_DIR first).
