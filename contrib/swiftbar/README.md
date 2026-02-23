# SwiftBar Plugin for CrewSwarm

macOS menu bar plugin. Shows live agent count and status, lets you start/stop/restart the stack and individual services from the menu bar.

## Install (automatic)

Run `bash install.sh` from the repo root — it detects SwiftBar and copies the plugin automatically.

## Install (manual)

```bash
cp contrib/swiftbar/openswitch.10s.sh \
  ~/Library/Application\ Support/SwiftBar/Plugins/openswitch.10s.sh
chmod +x ~/Library/Application\ Support/SwiftBar/Plugins/openswitch.10s.sh
```

Then edit the top of the installed file to set your repo path:

```bash
CREWSWARM_DIR="$HOME/Desktop/CrewSwarm"   # path to your CrewSwarm repo
```

## Requires

- [SwiftBar](https://swiftbar.app) — free macOS menu bar app
- Node.js 20+
- CrewSwarm running (`npm run restart-all`)

## What it shows

- Agent count and online/offline status (green/red dot)
- Per-service start/stop/restart controls (RT bus, crew-lead, dashboard, Telegram)
- Quick link to open the dashboard

## Notes

- SwiftBar refreshes the plugin every 10 seconds (the `.10s.` in the filename)
- Symlinks do not work with SwiftBar — the script must be a real file copy
- After pulling repo changes, re-run `bash install.sh` or manually re-copy the script
