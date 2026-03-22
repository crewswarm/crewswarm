# Install

Updated: March 14, 2026

Use this as the canonical setup path.

## What you get

`install.sh` handles:
- Node dependency install
- `~/.crewswarm/` bootstrap
- default config and RT token generation
- optional `crewchat` build on macOS
- optional SwiftBar plugin install
- optional Telegram setup
- optional WhatsApp setup
- optional MCP wiring for Cursor / Claude Code / OpenCode
- optional immediate local stack start

What it does not do by default:
- provision cloud infrastructure
- automatically deploy arbitrary generated apps to production
- choose a hosting platform for you

## Fastest Local Install

Fresh machine:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/install.sh)
```

Cloned repo:

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
bash install.sh
```

Then:

```bash
npm run doctor
npm run restart-all
open http://127.0.0.1:4319
```

## Cursor / Codex / Headless Install

For non-interactive setup:

```bash
CREWSWARM_SETUP_MCP=1 \
CREWSWARM_START_NOW=1 \
bash install.sh --non-interactive
```

Useful env flags:

- `CREWSWARM_BUILD_CREWCHAT=1`
- `CREWSWARM_SETUP_TELEGRAM=1`
- `TELEGRAM_BOT_TOKEN=...`
- `CREWSWARM_SETUP_WHATSAPP=1`
- `CREWSWARM_WHATSAPP_NUMBER=14155552671`
- `CREWSWARM_WHATSAPP_NAME=Jeff`
- `CREWSWARM_ENABLE_AUTONOMOUS=1`
- `CREWSWARM_AUTONOMOUS_MINUTES=15`
- `CREWSWARM_SETUP_MCP=1`
- `CREWSWARM_START_NOW=1`

This is the best path for:
- Cursor cloning the repo and wiring MCP automatically
- Codex or CI bootstrapping a machine without prompts
- remote shells where you want install + start in one shot

## Docker Install

For a server or team box:

```bash
curl -fsSL https://raw.githubusercontent.com/crewswarm/crewswarm/main/scripts/install-docker.sh | bash
```

Or:

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
docker compose up -d
```

Use Docker when you want:
- a stable shared instance
- easier restarts and host isolation
- team/server deployment instead of local development

## After Install

1. Add at least one provider key in Dashboard → Providers
2. Verify health:

```bash
npm run doctor
bash scripts/smoke.sh --no-build
bash scripts/smoke-surfaces.sh
```

3. Open the main surfaces:
- Dashboard: `http://127.0.0.1:4319`
- Vibe: `http://127.0.0.1:3333`
- crewchat: `/Applications/crewchat.app`

## Deployment Reality

crewswarm can build and operate projects locally, and Codex can absolutely use it to generate deployable code.

But deployment itself is still project-specific:
- static site
- Node server
- Docker service
- Fly / Railway / VPS / custom infra

So the current public claim should be:
- install and run crewswarm with one file: yes
- wire it into Cursor/Codex: yes
- automatically deploy every generated app with one universal command: no

## Recommended Public Path

For most users:

1. run `bash install.sh`
2. enable MCP if using Cursor / Claude Code / OpenCode
3. start with `npm run restart-all`
4. use Dashboard for setup
5. use Vibe for project work
6. use Docker only when moving to a server/team instance
