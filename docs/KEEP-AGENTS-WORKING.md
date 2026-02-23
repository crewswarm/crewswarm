# 🔧 How to Keep Your Agents Working Reliably

**Last Updated:** 2026-02-21

## ✅ Health checks (what we use now)

CrewSwarm does **not** ship a separate `health-check.sh`. Use these instead:

### 1. **Quick status**
```bash
bash scripts/openswitchctl status
# or, if installed to ~/bin:
bash ~/bin/openswitchctl status
```
**Expected:** `running (rt:up, agents:N/N)` with all agents listed and `:up`.

### 2. **Full system test**
```bash
node scripts/crewswarm-test.mjs --quick
```
**What it checks:** Config, RT token, agents, prompts, providers, processes, ports, RT daemon, dashboard, crew-lead. Run without `--quick` to include a live crew-pm round-trip.

### 3. **Optional: test without any OpenClaw config**
```bash
bash scripts/test-no-openclaw.sh
```
Temporarily moves `~/.openclaw` aside and runs the checks above to confirm everything works from `~/.crewswarm` only.

---

## 📋 Daily maintenance

### Morning check (~30 seconds)
```bash
bash scripts/openswitchctl status
```
If any agent shows `down`, restart:
```bash
bash scripts/openswitchctl restart
# or restart one agent:
bash scripts/openswitchctl restart-agent crew-coder
```

### Weekly check (~2 minutes)
```bash
node scripts/crewswarm-test.mjs --quick
tail -50 ~/.crewswarm/logs/*.log   # if you have logs there
# RT events (if using default path):
tail -100 ~/.crewswarm/workspace/shared-memory/claw-swarm/opencrew-rt/events.jsonl
```

---

## 🚨 Common issues & fixes

### "Agent not responding"
**Fix:** Restart that agent (or all):
```bash
bash scripts/openswitchctl restart-agent crew-coder
# or
bash scripts/openswitchctl restart
```

### "Invalid realtime token" / "pairing required"
**Fix:** All components must use the same RT token. Set it in `~/.crewswarm/config.json`:
```json
{ "rt": { "authToken": "<your-secret-token>" } }
```
Then restart: `bash scripts/openswitchctl restart`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#token-alignment-pairing-required--invalid-realtime-token).

### "Gateway timeout" / dashboard can't load sessions
Agents use **direct LLM calls** by default; a legacy gateway on port 18789 is optional. If the dashboard shows errors, check:
1. `openswitchctl status` — RT up, agents up.
2. Token alignment (see above).

### Rate limits (429)
If your provider rate-limits, switch models in `~/.crewswarm/crewswarm.json` (per-agent `model` and `providers`). Groq free tier is often used as a fallback.

### Tasks "done" but no files changed
Artifact validation in gateway-bridge should catch this. Ensure agents have the right tool permissions in `~/.crewswarm/crewswarm.json` (`agents[].tools.alsoAllow` or `crewswarmAllow`) and a valid model/provider.

---

## 🎯 How to test that everything works

### Quick send test
```bash
bash scripts/openswitchctl send crew-coder "Create /tmp/hello-crewswarm.txt with content Hello CrewSwarm"
```
**Expected:** File appears within ~30 seconds.

### Full test suite
```bash
node scripts/crewswarm-test.mjs
```
**Expected:** All sections pass (config, agents, prompts, providers, RT, dashboard, crew-lead chat, agent round-trip).

---

## 🔍 Monitoring

### Dashboard
Open: **http://127.0.0.1:4319** (CrewSwarm dashboard).

Check: agents up, DLQ low, RT messages flowing.

### SwiftBar
Use the CrewSwarm menu in the Mac menu bar (if you installed the SwiftBar plugin). Shows RT/agents status and quick actions.

### Logs
- Bridge logs: `/tmp/bridge-*.log` or under `~/.crewswarm/logs/`
- RT events: `~/.crewswarm/workspace/shared-memory/claw-swarm/opencrew-rt/events.jsonl` (or path from `SHARED_MEMORY_DIR`)

---

## 🛠️ Handy commands

```bash
bash scripts/openswitchctl status
bash scripts/openswitchctl restart
bash scripts/openswitchctl restart-agent crew-coder
bash scripts/openswitchctl send crew-coder "Your task here"
node scripts/crewswarm-test.mjs --quick
```

More detail: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
