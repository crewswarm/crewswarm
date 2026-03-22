# Cursor CLI (`agent`) in crewswarm

crewswarm **does not ship or control** the Cursor CLI. It **spawns** the same `agent` binary you would run in Terminal (see `lib/engines/runners.mjs` and `lib/crew-lead/http-server.mjs` engine passthrough for `cursor`).

If Cursor’s tool fails before it prints stream-json, crewswarm only sees **exit code + stderr** — there is nothing to “fix” in the orchestration layer until **`agent` works in a normal shell**.

## Official CLI reference

Run **`agent --help`** on your machine for the current flag list. Commonly relevant to crewswarm:

| Flag / env | Purpose |
|------------|---------|
| `-p` / `--print` | Non-interactive / script mode |
| `--output-format stream-json` | NDJSON events on stdout (what we parse) |
| `--stream-partial-output` | **Smaller text deltas** with `--print` + `stream-json` (crewswarm passes this for dashboard / Studio / gateway) |
| `--force` / `--yolo` | Allow tools without interactive approval |
| `--trust` | Trust workspace in headless mode |
| `--workspace <path>` | Project root (we pass your `projectDir`) |
| `--model <id>` | Cursor model id (`composer-2-fast`, etc.) |
| `agent login` / `agent logout` | Session auth |
| `--api-key` / **`CURSOR_API_KEY`** | Auth without Keychain (see below) |

Subcommands: `agent models`, `agent status`, `agent update`, etc.

## Quick smoke test (run outside crewswarm)

```bash
agent --list-models
agent -p --force --trust --output-format stream-json "hi" --model composer-2-fast --workspace "$PWD"
```

Both commands must succeed (or stream assistant output) **before** dashboard passthrough or gateway Cursor routing will behave.

## `ERROR: SecItemCopyMatching failed -50` (macOS)

That message comes from **macOS Security / Keychain** while Cursor’s CLI tries to read stored session or credentials. It is **not** a crewswarm bug.

Typical causes:

- Cursor.app session / login state out of sync with CLI
- Keychain access blocked for the terminal or the `agent` process
- Corrupt or stale Cursor-related keychain item
- Running only from a context where GUI login never completed

### Recovery (try in order)

1. **Open Cursor.app** and confirm you are fully signed in (account menu).
2. **Cursor → Settings →** reinstall or refresh the **CLI** / shell command if your Cursor version offers it.
3. **Quit Cursor completely** and reopen, then retry `agent --list-models` in **Terminal.app** (same user/session you use for development).
4. Run **`agent login`** (or sign out / sign in in the app) per [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication) if available in your build.
5. If it still fails, **avoid Keychain for headless use**: set a Cursor API key so the CLI does not depend on that lookup (next section).
6. As a last resort, remove the broken Cursor credential entry in **Keychain Access** (search for “Cursor”) and sign in again — only if you know what you’re deleting.

A full machine reboot is usually unnecessary; **app relaunch + re-auth** fixes most cases.

## Headless auth: `CURSOR_API_KEY`

For scripts, servers, and automation, Cursor documents using an API key so `agent` does not rely on interactive Keychain/session state:

- Set **`CURSOR_API_KEY`** in the environment before starting **crew-lead**, agent bridges, or the dashboard process that spawns passthrough.
- Or pass **`--api-key`** to `agent` (crewswarm does not add this flag by default; prefer env).

Official references:

- [CLI parameters](https://cursor.com/docs/cli/reference/parameters) (env / flags)
- [Headless CLI](https://cursor.com/docs/cli/headless)
- [Background agent API / API key](https://cursor.com/docs/background-agent/api/api-key-info) (how to obtain a key, if applicable to your plan)

In crewswarm, put persistent vars in **`~/.crewswarm/crewswarm.json` → `env`** or **Dashboard → Settings → Environment Variables**, then **restart** the services that spawn `agent` (at minimum **crew-lead** and any **gateway** processes).

## crewswarm-specific knobs

| Variable | Purpose |
|----------|---------|
| `CURSOR_CLI_BIN` | Absolute path to `agent` if not `~/.local/bin/agent` or `PATH` |
| `CREWSWARM_CURSOR_MODEL` | Default `--model` for passthrough / gateway (e.g. `composer-2-fast`) |
| `CURSOR_DEFAULT_MODEL` | Alternative default read by passthrough |
| `CURSOR_API_KEY` | Cursor CLI auth when Keychain path fails (see above) |

Per-agent Cursor model: `cursorCliModel` in `crewswarm.json` (see `lib/bridges/cli-executor.mjs`).

## When to use another engine

If `agent` cannot be stabilized on a machine (e.g. locked-down CI without Keychain/API key), switch that agent to **OpenCode**, **Claude Code**, **Codex**, or **Direct API** in **Dashboard → Settings → Engines** — crewswarm does not require Cursor CLI.
