# SwiftBar Plugin for OpenCrewHQ

**Last Updated:** 2026-02-22

macOS menu bar plugin for OpenCrewHQ (OpenClaw + OpenCrew RT). Single icon + "OpenCrewHQ" text (no emoji) for a clean status bar look.

## Where it lives

- **In repo (source of truth):** `contrib/swiftbar/openswitch.10s.sh`
- **SwiftBar runs it from:** `~/Library/Application Support/SwiftBar/plugins/openswitch.10s.sh`  
  You must **copy** the file there; symlinks do not work with SwiftBar. After pulling repo changes, re-copy if the plugin script was updated.

## Install

```bash
cp contrib/swiftbar/openswitch.10s.sh ~/Library/Application\ Support/SwiftBar/plugins/
chmod +x ~/Library/Application\ Support/SwiftBar/plugins/openswitch.10s.sh
```

If your repo or swarm paths differ, set `OPENCLAW_DIR` and `SWARM_PLUGIN_DIR` at the top of the script (default `OPENCLAW_DIR` is `$HOME/Desktop/CrewSwarm`).

## Start / Stop behavior (matches dashboard)

- **Stack:** ▶ Start / ⏹ Stop / ↺ Restart use `scripts/openswitchctl` (RT daemon + gateway bridges). They do **not** start crew-lead, dashboard, OpenCode, or Telegram.
- **Services (per row):** RT Bus and OpenClaw Gateway use `openswitchctl restart-rt` / `restart-openclaw`. Telegram, crew-lead, **OpenCode Server**, and Dashboard use `scripts/restart-service.sh <name>` — same logic as the dashboard’s Services tab (restart = stop then start; OpenCode uses `~/bin` in PATH and `command -v opencode` so it starts reliably).

## Requires

- [SwiftBar](https://github.com/swiftbar/SwiftBar)
- **openswitchctl** — the plugin prefers the repo script: `OPENCLAW_DIR/scripts/openswitchctl` (e.g. when `OPENCLAW_DIR` is your CrewSwarm repo). If missing, it uses `~/bin/openswitchctl`.
- OpenClaw Gateway + OpenCrew RT (optional)
