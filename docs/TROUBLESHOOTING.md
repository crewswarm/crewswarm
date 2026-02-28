# Troubleshooting

**Last Updated:** 2026-02-28

## Top 5 most common issues (quick reference)

| # | Symptom | Jump to |
|---|---------|---------|
| 1 | "pairing required" / "invalid realtime token" | [Token alignment](#token-alignment-pairing-required--invalid-realtime-token) |
| 2 | Agents don't respond / tasks hang | [Agents don't respond](#agents-dont-respond--gateway-closed) |
| 3 | `openswitchctl status` shows `agents: 0/N` | [RT daemons not connected](#rt-daemons-not-connected) |
| 4 | Multiple instances / port conflicts / 3+ Telegram replies | [Runaway processes](#runaway-processes--services-fighting-for-ports-after-restart) |
| 5 | "No config found" after fresh install | [No config](#no-config--no-config-found) |

Run `openswitchctl health` for a live snapshot. Run `openswitchctl doctor` for a full preflight check.

---

## 🔥 Top 5 Most Common Issues

### 1. **Token Misalignment** — "pairing required" / "invalid realtime token"
→ See full details below. **Quick fix:** Ensure `~/.crewswarm/config.json` has `rt.authToken` and restart all services.

### 2. **Agents Don't Respond** — dispatched tasks never complete
→ See "Agents don't respond / gateway closed" below. **Quick fix:** Run `bash scripts/openswitchctl status` then `start` if needed.

### 3. **PM Loop Fails to Dispatch** — tasks never reach agents
→ See "Token alignment" (PM loop needs token injected by dashboard). **Quick fix:** Restart dashboard, then restart PM loop from UI.

### 4. **Duplicate Replies** — Telegram bot or dashboard chat shows 3-4 copies
→ See "Duplicate replies" sections below. **Quick fix:** `pkill -f telegram-bridge.mjs` then restart once, or hard-refresh dashboard.

### 5. **No Config Found** — scripts report missing config
→ See "No config / 'No config found'" below. **Quick fix:** Run `bash install.sh` from the repo root.

---

## Token alignment ("pairing required" / "invalid realtime token")

**Symptom:** Dashboard, gateway-bridge, or crew-lead reports "pairing required", "gateway closed (1008)", or "invalid realtime token".

**Fix:** Everything that talks to the RT daemon must use the **same** RT auth token.

### Recommended: one token, one place

- **Use `~/.crewswarm/config.json` as the single source of truth** for the RT token (`rt.authToken`). The install script, openswitchctl, dashboard (when starting the PM loop), and docs all expect it there.
- If you also have `env.CREWSWARM_RT_AUTH_TOKEN` in `~/.crewswarm/crewswarm.json`, it must be the **same** value as `config.json`’s `rt.authToken`, or remove it so only config.json is used. Two different values in two files cause "invalid realtime token" when one component reads one file and another (or the RT daemon) uses the other.
- Start the RT daemon with that same token (e.g. `openswitchctl start` reads config.json), so the daemon and all clients agree.

### Why "direct send" works but the PM loop fails

- **Direct send** (e.g. `openswitchctl send crew-coder "task"` from a terminal): You (or the script) put the token in the environment (e.g. `export CREWSWARM_RT_AUTH_TOKEN=...` or openswitchctl reads config and passes it). The `gateway-bridge.mjs --send` process inherits that env, so the RT daemon accepts the request.
- **PM loop**: The dashboard spawns the PM loop as a child process. The PM loop then spawns `gateway-bridge.mjs --send` for each task. If the dashboard does **not** inject `CREWSWARM_RT_AUTH_TOKEN` into the PM loop’s spawn environment, the bridge runs with no token and every dispatch fails with "invalid realtime token". The dashboard is coded to load the token from `config.json` (and fallbacks) and inject it when starting the PM loop; restart the dashboard after that code is in place, then start the PM loop again.

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


3. If you use `env.CREWSWARM_RT_AUTH_TOKEN` in `~/.crewswarm/crewswarm.json`, set it to the same value as `config.json`’s `rt.authToken`, or delete it to avoid two sources.

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

---

## Duplicate replies from Telegram bot (3-4 replies per message)

**Symptom:** Every message sent via Telegram gets 3 or 4 identical replies.

**Cause:** Multiple `telegram-bridge.mjs` processes running simultaneously. Each restart spawns a new one without killing the old one.

**Fix:**
```bash
pkill -f "telegram-bridge.mjs"
node telegram-bridge.mjs &
```

The bridge now uses a PID file (`~/.crewswarm/logs/telegram-bridge.pid`) as a singleton guard — a second instance exits immediately. If the PID file is stale after a crash:
```bash
rm ~/.crewswarm/logs/telegram-bridge.pid
node telegram-bridge.mjs &
```

---

## Duplicate replies in main dashboard chat from CLI passthrough

**Symptom:** After a Codex/Gemini/Claude CLI passthrough completes, the reply appears twice in the chat — once streamed live, once as a duplicate bubble.

**Cause:** The passthrough endpoint sent live SSE chunks AND a final `agent_reply` SSE event. Both rendered.

**Fix:** Already patched — the final summary event is tagged `_passthroughSummary: true` and the frontend skips rendering it. If you still see duplicates, hard-refresh the dashboard (`Cmd+Shift+R`).

---

## Codex CLI says "no write control" / blocks on approval prompt

**Symptom:** Codex passthrough hangs or reports it cannot write files. The process waits for manual approval.

**Cause:** Older invocation used `--sandbox workspace-write` which still prompts for write approval in non-interactive mode.

**Fix:** Codex is now invoked with `--full-auto` which auto-approves all writes:
```
codex exec --full-auto --json "your task"
```

If you're running Codex manually, always pass `--full-auto` for non-interactive use.

---

## Gemini CLI passthrough blocks on file write approval

**Symptom:** Gemini CLI passthrough hangs waiting for user approval to write files.

**Fix:** Gemini is now invoked with `--approval-mode yolo` which auto-approves all tool calls. If running manually:
```bash
gemini -p "your task" --output-format stream-json --approval-mode yolo
```

---

## Codex / Gemini session drops between chats (starts fresh every time)

**Symptom:** Each new message to Codex or Gemini CLI starts a brand-new session with no memory of previous conversation.

**Fix:** Session IDs are now stored in `~/.crewswarm/passthrough-sessions.json` and reused:
- Codex uses `exec resume --last` when a prior session exists for the project directory
- Gemini uses `--resume <session_id>` captured from the `init` stream event

If you want to force a fresh session (clear stored IDs):
```bash
rm ~/.crewswarm/passthrough-sessions.json
```

---

## Environment Variables tab shows blank inputs / "default" values don't appear

**Symptom:** The Settings → Environment Variables tab shows empty text fields even for variables that have defaults.

**Cause (old):** Inputs used `value="${saved ?? ''}"` — when a variable wasn't in `crewswarm.json`, the field showed blank instead of the code default.

**Fix:** Inputs now use `value="${saved ?? default ?? ''}"` — unset variables pre-populate with their code default and show a "default" badge. Hard-refresh (`Cmd+Shift+R`) if still blank after updating.

---

## "Failed to parse URL from /models" for Cerebras / NVIDIA NIM / Google in Models tab

**Symptom:** Models tab shows `✗ Failed to parse URL from /models` next to Cerebras, NVIDIA NIM, or Google providers.

**Cause:** Missing `BUILTIN_URLS` entries — the dashboard tried to call `/models` with no base URL.

**Fix:** Already resolved — correct API base URLs are now in `scripts/dashboard.mjs → BUILTIN_URLS`. Restart the dashboard if you see this on an older install:
```bash
pkill -f "dashboard.mjs" && node scripts/dashboard.mjs &
```

---

## Skills tab shows only 7-8 skills despite having 44 installed

**Symptom:** Dashboard → Skills shows only the JSON API skills. The SKILL.md knowledge skills (roadmap-planning, code-review, ai-seo, etc.) don't appear.

**Cause (old):** `GET /api/skills` only read `.json` files. Folder-based `SKILL.md` skills were invisible to the API.

**Fix:** Already resolved — the API now returns all skills with a `type` field (`"api"` or `"knowledge"`). The Skills tab shows two sections: **Knowledge** and **API Integrations**. Restart crew-lead if you see the old behaviour:
```bash
pkill -f "crew-lead.mjs" && node crew-lead.mjs &
```

---

## Runaway processes / services fighting for ports after restart

**Symptom:** After `npm run restart-all`, multiple copies of the same service start. Port conflicts appear (`EADDRINUSE`). Telegram bridge sends 3+ replies.

**Cause:** Old restart script used overly specific `pkill` patterns that missed some process variants. WhatsApp/Telegram bridges accumulated multiple instances.

**Fix:** `scripts/restart-all-from-repo.sh` now uses broader patterns and kills all related processes. Bridges have singleton guards (PID files). If you still see issues:

```bash
# Nuclear option — kill everything and restart clean
pkill -f "crew-lead.mjs" || true
pkill -f "gateway-bridge.mjs" || true
pkill -f "telegram-bridge.mjs" || true
pkill -f "whatsapp-bridge.mjs" || true
pkill -f "dashboard.mjs" || true
pkill -f "opencrew-rt-daemon.mjs" || true
sleep 2
npm run restart-all
```
