# Live Verification

These checks cover the last parts of the system that cannot be made fully hermetic:

- native macOS `crewchat`
- real Telegram / WhatsApp delivery
- real funded-provider quota / fallback behavior

## Provider / Failover Matrix

Run:

```bash
node scripts/live-provider-failover-matrix.mjs
```

This prints:

- configured providers from `~/.crewswarm/crewswarm.json`
- important routed agents and their primary/fallback models
- a short execution checklist for live failover verification

Use it together with:

```bash
npm run restart-all
node scripts/health-check.mjs
```

Then run one real task per important route and confirm the observed runtime/model in logs or UI.

## Messaging Bridges

Run:

```bash
node scripts/live-bridge-matrix.mjs
```

This prints:

- whether Telegram / WhatsApp are configured locally
- whether bridge logs and message logs exist
- the live checklist for network delivery verification

Then run:

```bash
node --test test/e2e/telegram-roundtrip.test.mjs
node --test test/e2e/whatsapp-roundtrip.test.mjs
```

These remain live tests by nature because they depend on:

- real bot credentials
- real device auth
- real third-party network delivery

## crewchat

Run:

```bash
node scripts/live-crewchat-check.mjs
```

Then:

```bash
./build-crewchat.sh
open -a crewchat.app
```

Verify:

- mode switching between crew-lead / CLI / direct agent
- text send
- image send
- voice note send
- per-project history isolation
- visible runtime/source labeling

## Interpretation

- Hermetic tests protect logic and contracts.
- Live checks protect external integrations and platform-native behavior.
- A public release should pass both categories.
