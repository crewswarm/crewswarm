# OpenCrew RT Global Deployment (Secure)

This setup links agents across the internet with hardened security.

## 1) Server Host + WSS

- Run OpenCrew RT on a public host or VPS.
- Use TLS and expose only `443` through a reverse proxy.
- Recommended env:

```bash
export OPENCREW_RT_HOST=0.0.0.0
export OPENCREW_RT_PORT=18889
export OPENCREW_RT_REQUIRE_TOKEN=1
export OPENCREW_RT_REQUIRE_AGENT_TOKEN=1
export OPENCREW_RT_AUTH_TOKEN="fallback-global-token"
export OPENCREW_RT_AGENT_TOKENS="openclaw-main:<token1>;opencode-pm:<token2>;opencode-qa:<token3>;opencode-fixer:<token4>;orchestrator:<token5>"
export OPENCREW_RT_ALLOWED_ORIGINS="https://ops.yourdomain.com"
export OPENCREW_RT_MAX_MESSAGE_BYTES=65536
export OPENCREW_RT_RATE_LIMIT_PER_MIN=300
export OPENCREW_RT_TLS_KEY_PATH="/etc/ssl/private/opencrew.key"
export OPENCREW_RT_TLS_CERT_PATH="/etc/ssl/certs/opencrew.crt"
```

## 2) Client Agents (Anywhere)

Each remote agent should use:

```bash
export OPENCREW_RT_URL="wss://rt.yourdomain.com"
export OPENCREW_RT_AUTH_TOKEN="<agent-specific-token>"
export OPENCREW_RT_AGENT="openclaw-main" # or opencode-pm/opencode-qa/etc
export OPENCREW_RT_CHANNELS="command,assign,handoff,reassign,events"
```

## 3) Network Controls

- Keep firewall allowlist tight (office IPs, trusted nodes, VPN ranges).
- Use fail2ban or WAF for repeated auth failures.
- Rotate agent tokens on schedule.

## 4) Reliability Controls

- Keep `openswitchctl` supervision for OpenClaw daemon.
- Monitor `channels/issues.jsonl` and `acks.jsonl` for timeout spikes.
- Add orchestrator retry policy for `task.failed` events.

## 5) Verification

1. `openclaw-main` heartbeat appears in `channels/status.jsonl`.
2. `opencode-pm` publishes `command.run_task`.
3. OpenClaw writes `received -> done|failed` ACK chain.
4. Completion appears in `channels/done.jsonl` or failure in `channels/issues.jsonl`.
