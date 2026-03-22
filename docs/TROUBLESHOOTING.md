# Troubleshooting

Top issues and fixes for crewswarm.

## Agents not responding

```bash
npm run restart-all
```

Check logs:

```bash
tail -f /tmp/crew-lead.log
tail -f /tmp/opencrew-rt-daemon.log
tail -f /tmp/bridge-crew-coder.log
```

Run health check:

```bash
npm run health
```

## No API key error

Open **Dashboard → Providers** and add at least one API key. Groq is free: https://console.groq.com/keys

## crew-lead not reachable

```bash
curl http://127.0.0.1:5010/health
```

If 404, restart:

```bash
node crew-lead.mjs
```

### Multiple crew-lead processes / Chat flaky

Only **one** crew-lead should listen on **5010**. A second `node crew-lead.mjs` (or **LaunchAgent + manual** start) used to race the port and confuse the dashboard.

- **Check:** `lsof -nP -iTCP:5010 -sTCP:LISTEN`
- **Canonical PID file:** `~/.crewswarm/logs/crew-lead.pid` (used by **Services → Stop** and `scripts/restart-crew-lead.sh`)
- **Clean restart:** `bash scripts/restart-crew-lead.sh` (stops extras, starts one)
- If you see *“already running”* but nothing listens: `rm -f ~/.crewswarm/logs/crew-lead.pid` and restart (stale file after crash)

## Dashboard won't start or restart

The dashboard **cannot** restart itself via its REST API (race condition). Always use:

```bash
npm run restart-dashboard
# or
bash scripts/restart-dashboard.sh
```

Never call `/api/services/restart` with `"id":"dashboard"` — it will fail.

## File not written by agent

Check tool permissions in `~/.crewswarm/crewswarm.json`:

```json
{
  "id": "crew-coder",
  "tools": { "crewswarmAllow": ["read_file", "write_file", "mkdir", "run_cmd"] }
}
```

Role defaults are in `lib/tools/executor.mjs` → `AGENT_TOOL_ROLE_DEFAULTS`.

## Duplicate Telegram/WhatsApp replies

Multiple bridge instances running. Kill and restart:

```bash
pkill -f telegram-bridge.mjs
node telegram-bridge.mjs &
```

Remove stale `.pid` in `~/.crewswarm/logs/` if needed.

## Pipeline timeout

Check which agent is stuck:

```bash
tail -f /tmp/bridge-crew-coder.log
```

Restart a specific bridge:

```bash
node scripts/start-crew.mjs --restart crew-coder
```

## Token / auth errors

- Ensure model IDs use `provider/model-id` format
- Check provider API key in Dashboard → Providers
- Verify `~/.crewswarm/crewswarm.json` has correct `providers` block

## Cursor CLI / `agent` fails (`SecItemCopyMatching`, exit 1, no output)

The dashboard and gateway only **spawn** Cursor’s **`agent`** binary. If you see **`ERROR: SecItemCopyMatching failed -50`** or passthrough exits before any stream, fix **local Cursor + macOS Keychain / login** (or use **`CURSOR_API_KEY`**) — not crewswarm routing.

**Canonical guide:** [docs/CANONICAL/CURSOR-CLI.md](CANONICAL/CURSOR-CLI.md)

**Quick check:**

```bash
agent --list-models
```

## Codex passthrough: `rmcp::transport`, `127.0.0.1:4097/mcp`, Connection refused

**Codex CLI** loads **MCP servers** from your Codex config (e.g. `~/.codex/config.toml` / `codex mcp list`). If one points at **`http://127.0.0.1:4097/mcp`** (the **crew-cli** MCP from [crew-cli/docs/MCP-CLI-INTEGRATION.md](../crew-cli/docs/MCP-CLI-INTEGRATION.md)) but nothing is listening, the Rust MCP client (**rmcp**) logs errors on stderr — often **exit still 0** with noisy logs.

**Fix (pick one):**

1. **Start crew-cli MCP on 4097** (from the `crew-cli` package in this repo):
   ```bash
   cd crew-cli && crew serve --port 4097
   ```
   Check: `curl -sS http://127.0.0.1:4097/mcp/health` (or your server’s health path).

2. **Use crewswarm MCP on 5020 instead** (if you run `node scripts/mcp-server.mjs` or `npm run restart-all`):
   ```bash
   codex mcp list
   codex mcp remove crew-cli   # or whatever name points at :4097
   codex mcp add crewswarm --url "http://127.0.0.1:5020/mcp" --bearer-token-env-var CREWSWARM_TOKEN
   ```

3. **Remove** the unused MCP server from Codex so it stops trying to connect.

Passthrough UI filters most **rmcp** noise, but fixing the **underlying MCP URL or process** is the real solution.

## Skills tab shows few skills

Restart crew-lead. The API returns all skills (JSON + SKILL.md) with `type: "api" | "knowledge"`.

## @@RUN_CMD blocked

Pre-approve patterns in **Settings → Command Allowlist** (e.g. `npm *`, `node *`). Dangerous commands (`rm -rf`, `sudo`, `curl | bash`) are always hard-blocked.
