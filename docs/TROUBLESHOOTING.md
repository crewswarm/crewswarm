# Troubleshooting

**Last Updated:** 2026-02-21

## Token alignment ("pairing required" / "invalid realtime token")

**Symptom:** Dashboard, gateway-bridge, or crew-lead reports "pairing required", "gateway closed (1008)", or "invalid realtime token".

**Fix:** Everything that talks to the RT daemon must use the **same** RT auth token.

### Recommended: one token, one place

- **Use `~/.crewswarm/config.json` as the single source of truth** for the RT token (`rt.authToken`). The install script, openswitchctl, dashboard (when starting the PM loop), and docs all expect it there.
- If you also have `env.OPENCREW_RT_AUTH_TOKEN` in `~/.crewswarm/crewswarm.json`, it must be the **same** value as `config.json`’s `rt.authToken`, or remove it so only config.json is used. Two different values in two files cause "invalid realtime token" when one component reads one file and another (or the RT daemon) uses the other.
- Start the RT daemon with that same token (e.g. `openswitchctl start` reads config.json), so the daemon and all clients agree.

### Why "direct send" works but the PM loop fails

- **Direct send** (e.g. `openswitchctl send crew-coder "task"` from a terminal): You (or the script) put the token in the environment (e.g. `export OPENCREW_RT_AUTH_TOKEN=...` or openswitchctl reads config and passes it). The `gateway-bridge.mjs --send` process inherits that env, so the RT daemon accepts the request.
- **PM loop**: The dashboard spawns the PM loop as a child process. The PM loop then spawns `gateway-bridge.mjs --send` for each task. If the dashboard does **not** inject `OPENCREW_RT_AUTH_TOKEN` into the PM loop’s spawn environment, the bridge runs with no token and every dispatch fails with "invalid realtime token". The dashboard is coded to load the token from `config.json` (and fallbacks) and inject it when starting the PM loop; restart the dashboard after that code is in place, then start the PM loop again.

So: same token everywhere; direct send works because the token is in env; PM loop works only when the dashboard passes that token into the loop’s env.

### Steps

1. Check token in canonical config:
   ```bash
   node -e "const c=require('fs').readFileSync(process.env.HOME+'/.crewswarm/config.json','utf8'); console.log(JSON.parse(c).rt?.authToken?.slice(0,12)+'...');"
   ```

2. Ensure `~/.crewswarm/config.json` has it:
   ```json
   {
     "rt": { "authToken": "<your-secret-token>" }
   }
   ```


3. If you use `env.OPENCREW_RT_AUTH_TOKEN` in `~/.crewswarm/crewswarm.json`, set it to the same value as `config.json`’s `rt.authToken`, or delete it to avoid two sources.

4. Restart RT and agents so they reload config:
   ```bash
   bash scripts/openswitchctl restart
   ```
   Or from repo: `bash "$(pwd)/scripts/openswitchctl" restart`

5. If the PM loop was failing: restart the **dashboard** (so it loads the token and injects it when starting the PM loop), then start the PM loop again from the dashboard.

---

## "agentId is not allowed" / sessions_spawn

**Symptom:** An agent or UI tries to spawn/target another agent and gets "agentId is not allowed" or "allowed: none".

**Explanation:** The RT daemon has an allowlist: built-in default includes all crew-* agents; you can override with `CREWSWARM_ALLOWED_AGENTS`. crew-lead and the dashboard dispatch via the RT bus; direct `sessions_spawn` from some clients is restricted.

**Fix:** Use crew-lead chat or the dashboard to dispatch tasks. For scripted builds, use the orchestrator from the CrewSwarm repo:
```bash
node scripts/run.mjs "your requirement"
```

---

## Agents don't respond / "gateway closed"

**Symptom:** Dispatched tasks never complete, or bridge reports "gateway closed".

**What we do:** Agents use **direct LLM calls** by default (no external gateway). A legacy gateway on port 18789 is optional.

**Fix:**
1. Check status: `bash scripts/openswitchctl status` — you want `rt:up` and `agents: N/N` (e.g. 13/13).
2. If agents are down: `bash scripts/openswitchctl start` (or Start from the dashboard).
3. If token errors: fix token alignment (see above).
4. Run the health check: `npm run health` to see which component fails.

---

## RT daemons not connected

**Symptom:** `openswitchctl status` shows `agents: 0/N` (e.g. 0/13).

**Fix:**
```bash
bash scripts/openswitchctl start
# or full restart
bash scripts/openswitchctl restart
```
Ensure the RT server is listening on port 18889 and that `~/.crewswarm/config.json` has the same `rt.authToken` that crew-lead and gateway-bridge use.

---

## Orchestrator hangs or times out

**Symptom:** `node scripts/run.mjs "requirement"` runs but PM or workers never complete.

**Checks:**
1. Daemons running? `bash scripts/openswitchctl status`
2. Token aligned? See "Token alignment" above.
3. Logs: `~/.crewswarm/logs/`, or `tail -f /tmp/bridge-*.log` for gateway-bridge.
4. Try a tiny task first: e.g. "Create test-output/hello.txt with contents Hello World"

---

## QA (crew-qa) gets ENOENT when reviewing PM-loop tasks

**Symptom:** After a task completes, crew-qa reports `Cannot read ... ENOENT` for paths like `index.html`, `test-output/`, or `styles.css` in the project output dir.

**Cause:** crew-qa has **read_file** permission only (no mkdir/write). The bridge does **not** restrict paths by workspace — QA can read any path the process can access. ENOENT means the file or directory doesn’t exist at that path (e.g. the creating agent’s workspace was elsewhere, or the task didn’t create those files). QA was also guessing common paths (index.html, styles.css) instead of being told which files exist.

**Fix (code):** The PM loop now injects a list of **existing file paths** in the project output dir into the QA review prompt. QA is instructed to use `@@READ_FILE` only on those paths. So QA no longer tries to read non-existent files.

**Config:** If you want QA to be able to create missing dirs (not usually needed), you could add `mkdir` to crew-qa in `~/.crewswarm/crewswarm.json` under that agent’s `tools.alsoAllow`. By default QA stays read-only.

---

## Shared memory not loading (MEMORY_LOAD_FAILED)

**Symptom:** Agents report "MEMORY_LOAD_FAILED" or missing context.

**Fix:** Ensure `memory/` exists in the **CrewSwarm repo** (or your project root) and contains at least:
- `current-state.md`
- `agent-handoff.md`
- `orchestration-protocol.md`

Gateway-bridge bootstraps missing files when run from the repo root. Run orchestration with `cwd` set to the CrewSwarm repo or the project that has `memory/`.

---

## No config / "No config found"

**Symptom:** Scripts or dashboard say no config found.

**Fix:** Run the installer from the repo:
```bash
bash install.sh
```
This creates `~/.crewswarm/crewswarm.json`, `config.json`, and copies `agent-prompts.json`. Then add your provider API keys in the Dashboard (Providers) or by editing `~/.crewswarm/crewswarm.json`.
