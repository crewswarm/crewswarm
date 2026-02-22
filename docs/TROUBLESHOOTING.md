# Troubleshooting

**Last Updated:** 2026-02-20

## Token Alignment ("pairing required" / "invalid realtime token")

**Symptom:** Control UI or gateway-bridge reports "pairing required", "gateway closed (1008)", or "invalid realtime token".

**Fix:** `~/.openclaw/openclaw.json` and `~/.opencrew/openswitch.env` must use the **same** RT token.

1. Check OpenCrew token:
   ```bash
   grep OPENCREW_RT_AUTH_TOKEN ~/.opencrew/openswitch.env
   ```

2. Ensure `openclaw.json` has it:
   ```json
   {
     "env": {
       "OPENCREW_RT_AUTH_TOKEN": "<same token as openswitch.env>"
     }
   }
   ```

3. Restart gateway and RT daemons:
   ```bash
   bash ~/bin/openswitchctl restart-all
   ```

---

## sessions_spawn "agentId is not allowed (allowed: none)"

**Symptom:** Quill or main agent tries `sessions_spawn` and gets "agentId is not allowed for sessions_spawn (allowed: none)".

**Explanation:** The main agent is not allowed to target other agents via `sessions_spawn`. This is intentional; the swarm uses the external orchestrator instead.

**Fix:** Use `exec` to run the unified orchestrator when you need to build something:
```bash
node /Users/jeffhobbs/Desktop/OpenClaw/unified-orchestrator.mjs "your requirement"
```

Quill is instructed via `~/.openclaw/workspace/SOUL.md` and `AGENTS.md` to do this automatically when you say "build X" or "create Y".

---

## Gateway Not Running

**Symptom:** `sessions_list` fails, "gateway closed", or agents don't respond.

**Fix:**
1. Start the gateway (usually via OpenClaw / Cursor)
2. Or run: `openclaw gateway` (if available)
3. Check status: `bash ~/bin/openswitchctl status` — gateway should be up on port 18789

---

## RT Daemons Not Connected

**Symptom:** `openswitchctl status` shows `agents: 0/7` or similar.

**Fix:**
```bash
bash ~/bin/openswitchctl start
# or
bash ~/bin/openswitchctl restart-all
```

Ensure OpenCrew RT server is running (port 18889) and token matches.

---

## Orchestrator Hangs or Times Out

**Symptom:** `node unified-orchestrator.mjs "requirement"` runs but PM or workers never complete.

**Checks:**
1. Are daemons running? `bash ~/bin/openswitchctl status`
2. Is gateway up? Port 18789
3. Check logs: `~/.openclaw/logs/openclaw-rt-*.log`
4. Try a smaller task first (e.g. "Create test-output/hello.txt with contents Hello World")

---

## Shared Memory Not Loading

**Symptom:** Agents report "MEMORY_LOAD_FAILED" or missing context.

**Fix:** Ensure `memory/` exists in the OpenClaw project directory and contains at least:
- `current-state.md`
- `decisions.md`
- `agent-handoff.md`
- `orchestration-protocol.md`

Gateway-bridge auto-bootstraps missing files. Run from project root: `cd /Users/jeffhobbs/Desktop/OpenClaw` before orchestration.
