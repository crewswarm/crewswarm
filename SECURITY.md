# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest) | ✅ Active |
| Older releases | ❌ No patches |

We strongly recommend always running the latest commit on `main`.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via email:

**info@crewswarm.ai**

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept or detailed steps)
- Any relevant file paths, line numbers, or config values
- Your name/handle if you'd like credit in the fix commit

### What to expect

| Timeline | What happens |
|---|---|
| Within **48 hours** | Acknowledgement of your report |
| Within **7 days** | Initial assessment and severity rating |
| Within **30 days** | Fix shipped (critical/high) or fix timeline communicated (medium/low) |
| After fix ships | Public disclosure with credit (if desired) |

We follow **coordinated disclosure** — we ask that you give us reasonable time to patch before publishing details publicly.

---

## Scope

### In scope

- Remote code execution via agent tool calls (`@@RUN_CMD`, `@@WRITE_FILE`)
- Auth bypass on crew-lead API (port 5010) or dashboard (port 4319)
- RT bus token exposure or forgery
- Prompt injection attacks that escape the agent sandbox
- Skill definitions that exfiltrate secrets or make unauthorized external calls
- Command allowlist bypass
- Path traversal via `@@READ_FILE` or `@@WRITE_FILE`

### Out of scope

- Issues that require physical access to the machine running crewswarm
- Issues in third-party LLM providers (Groq, Anthropic, OpenAI, etc.) — report those upstream
- Denial-of-service via intentionally malformed requests from the local user
- Social engineering attacks

---

## Security model

crewswarm is designed to run **locally on your machine** — not exposed to the internet by default. Key assumptions:

1. **Ports 4319, 5010, 18889 are localhost-only** — do not expose these ports publicly without a reverse proxy and proper authentication.
2. **Agent tool calls are gated** — `@@RUN_CMD` from untrusted agents requires dashboard approval. Pre-approve only patterns you trust.
3. **Bearer token auth** — all crew-lead API calls require the RT auth token from `~/.crewswarm/config.json`. Protect this file.
4. **Skill definitions** — imported skills can make HTTP calls. Review skill JSON before importing from untrusted sources.
5. **API keys** — stored in `~/.crewswarm/crewswarm.json`. This file should be `chmod 600` and never committed.

---

## Hardening checklist

If you expose crewswarm beyond localhost:

- [ ] Put a reverse proxy (nginx/Caddy) with TLS in front of port 4319
- [ ] Add IP allowlisting or HTTP Basic Auth at the proxy layer
- [ ] Rotate the RT auth token (`rt.authToken` in `~/.crewswarm/config.json`) regularly
- [ ] Review `~/.crewswarm/cmd-allowlist.json` — minimize pre-approved patterns
- [ ] Never commit `~/.crewswarm/crewswarm.json` (contains API keys)
- [ ] Use `WA_ALLOWED_NUMBERS` / `TELEGRAM_ALLOWED_USERNAMES` to restrict messaging bridges

---

## Hall of fame

Security researchers who have responsibly disclosed issues will be credited here (with their permission).

*No reports yet — you could be first.*
