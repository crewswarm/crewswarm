# Keeping Agents Working

Operational tips for reliable agent execution.

## Restart everything

```bash
npm run restart-all
```

Restarts: RT bus → agent bridges → crew-lead → dashboard.

## Restart agents only

```bash
node scripts/start-crew.mjs --force
```

Keeps dashboard and crew-lead running; restarts all gateway bridges.

## Restart single agent

```bash
node scripts/start-crew.mjs --restart crew-coder
```

## Check health

```bash
npm run health
```

Verifies paths, config, and running services.

## Logs

```bash
tail -f /tmp/crew-lead.log
tail -f /tmp/opencrew-rt-daemon.log
tail -f /tmp/bridge-crew-coder.log
```

## Timeouts

If agents hang, increase timeouts in `~/.crewswarm/crewswarm.json` env:

- `CREWSWARM_ENGINE_IDLE_TIMEOUT_MS` — engine silence before kill
- `CREWSWARM_DISPATCH_CLAIMED_TIMEOUT_MS` — claimed task timeout

## @@KILL when stuck

Type `@@KILL` in chat to SIGTERM all agent bridges. Then restart:

```bash
node scripts/start-crew.mjs
```
