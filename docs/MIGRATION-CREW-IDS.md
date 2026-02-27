# Migration: opencode-* → crew-* Agent IDs

**Date:** 2026-02-20

Agent IDs have been renamed from `opencode-*` / `openclaw-main` to `crew-*` for consistency with CrewSwarm branding.

## New Agent IDs

| Old ID          | New ID        |
|-----------------|---------------|
| `openclaw-main` | `crew-main`   |
| `opencode-pm`   | `crew-pm`     |
| `opencode-coder`| `crew-coder`  |
| `opencode-coder-2` | `crew-coder-2` |
| `opencode-qa`   | `crew-qa`     |
| `opencode-fixer`| `crew-fixer`  |
| `security`      | `security` (unchanged) |

## Required: Update openswitchctl

The `~/bin/openswitchctl` script (or equivalent swarm control script) spawns daemons with `OPENCREW_RT_AGENT` set. Update it to use the new IDs:

**Before:**
```bash
OPENCREW_RT_AGENT=opencode-coder node gateway-bridge.mjs ...
OPENCREW_RT_AGENT=opencode-pm node gateway-bridge.mjs ...
```

**After:**
```bash
OPENCREW_RT_AGENT=crew-coder node gateway-bridge.mjs ...
OPENCREW_RT_AGENT=crew-pm node gateway-bridge.mjs ...
```

Update the agent list that openswitchctl uses to spawn daemons:
- `crew-main`, `crew-pm`, `crew-qa`, `crew-fixer`, `crew-coder`, `crew-coder-2`, `security`

## Log File Paths

If your openswitchctl uses log paths like `~/.opencrew/logs/openclaw-rt-${AGENT}.log`, they will change:
- `openclaw-rt-openclaw-main.log` → `openclaw-rt-crew-main.log`
- `openclaw-rt-opencode-coder.log` → `openclaw-rt-crew-coder.log`
- etc.

## Environment Override

You can override the default swarm list without modifying gateway-bridge.mjs:

```bash
export OPENCREW_RT_SWARM_AGENTS="crew-main,crew-pm,crew-qa,crew-fixer,crew-coder,crew-coder-2,security"
```

## After Migration

1. Stop all daemons: `bash ~/bin/openswitchctl stop` (or equivalent)
2. Update openswitchctl with new agent IDs
3. Restart: `bash ~/bin/openswitchctl start`
4. Verify: `bash ~/bin/openswitchctl status` — should show `crew-main:up`, `crew-pm:up`, etc.
