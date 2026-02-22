# SwiftBar Plugin for OpenCrewHQ

**Last Updated:** 2026-02-20

macOS menu bar plugin for OpenCrewHQ (OpenClaw + OpenCrew RT). Single icon + "OpenCrewHQ" text (no emoji) for a clean status bar look.

## Install

Copy `openswitch.10s.sh` to SwiftBar plugins:

```bash
cp contrib/swiftbar/openswitch.10s.sh ~/Library/Application\ Support/SwiftBar/plugins/
chmod +x ~/Library/Application\ Support/SwiftBar/plugins/openswitch.10s.sh
```

If your OpenClaw or swarm paths differ, edit the script: set `OPENCLAW_DIR` and `SWARM_PLUGIN_DIR` at the top.

## Requires

- [SwiftBar](https://github.com/swiftbar/SwiftBar)
- `~/bin/openswitchctl` (from swarm setup)
- OpenClaw Gateway + OpenCrew RT
