# Using Your ChatGPT (OAuth) Account Instead of API Credits

## Short answer

**Officially:** No. ChatGPT (Plus/Pro, OAuth login) and the OpenAI API are separate products. Same account, but your subscription does **not** include API usage. API calls are billed separately at [OpenAI API pricing](https://openai.com/api/pricing/).  
See: [API access as a ChatGPT Plus Subscriber](https://community.openai.com/t/api-access-as-a-chatgpt-plus-subscriber/573409) — “ChatGPT and the OpenAI API platform are two separate things. … The extension you’re talking about seems to require an API key, from the white platform. To use that, you have to add a payment method, and you will be charged for what you use.”

**Unofficial option:** You can use a local proxy that authenticates with your ChatGPT account (same OAuth flow as Codex) and exposes an OpenAI-compatible API that uses your **subscription** instead of API billing.

---

## Official: Codex and “subscription access”

Codex (OpenAI’s coding CLI) supports two auth modes:

- **Sign in with ChatGPT** → subscription access (uses your Plus/Pro plan).
- **Sign in with API key** → usage-based, billed at standard API rates.

From [OpenAI Codex – Authentication](https://developers.openai.com/codex/auth/):

- “Sign in with ChatGPT for subscription access”
- “OpenAI bills **API key** usage through your OpenAI Platform account at standard API rates.”

So for **Codex itself** you can use your premium account. CrewSwarm does not use Codex; it calls the OpenAI HTTP API directly, which requires an API key and is always billed per use unless you route through something that uses subscription.

---

## Unofficial: ChatMock (ChatGPT plan as API proxy)

**[ChatMock](https://github.com/RayBytes/ChatMock)** is an open-source project that:

- Uses the same OAuth flow as Codex (ChatGPT login).
- Runs a **local OpenAI-compatible server** (e.g. `http://127.0.0.1:8000/v1`).
- Fulfils requests using your **ChatGPT subscription** instead of API credits.

You log in once (`python chatmock.py login` or the Mac app), then run the server (`python chatmock.py serve`). Any app that talks to the OpenAI API can point at this server as `baseUrl` and use your plan’s limits instead of paying per API call.

### Using it with CrewSwarm

1. Install and run ChatMock (see [ChatMock README](https://github.com/RayBytes/ChatMock)) so it is listening (e.g. `http://127.0.0.1:8000/v1`).
2. In Dashboard → **Providers** → **Built-in**, find **OpenAI (local)** (same row as Ollama). Click to expand, then **Save** (you can leave the key blank — we store a placeholder so the stack works). Use **Test** to confirm ChatMock is reachable.
3. In **Agents**, set crew-lead (or any agent) to use a model from **openai-local**, e.g. `openai-local/gpt-5` or `openai-local/codex-mini` (use **Fetch models** on the provider to see ChatMock’s list).
4. Traffic then goes through ChatMock and counts against your ChatGPT plan.

### Caveats

- **Not official.** “Use responsibly and at your own risk. This project is not affiliated with OpenAI.”
- **Paid ChatGPT required.** Plus/Pro (or equivalent).
- **Rate limits** may differ from the ChatGPT app (often slightly stricter).
- **System prompt:** ChatMock cannot set the real backend system prompt; some projects work around this by sending instructions as a user message. For many chat/completion use cases this is acceptable.
- **Models:** Supports GPT-5, GPT-5 Codex, codex-mini, etc. (see [ChatMock supported models](https://github.com/RayBytes/ChatMock#supported-models)).

---

## Is ChatMock safe? (Security and safety notes)

**Repo stats (as of early 2026):** ~1.3k stars, ~165 forks, MIT license, active (issues/PRs). No security advisories or "exposed keys" issues found in GitHub issues; discussion is mostly login flow, model support, and n8n/Docker.

**What we checked:**

- **Credentials stay local.** Auth is stored in a local file under your home directory (ChatMock uses its own path, not `~/.codex/auth.json`). The OAuth flow talks only to **OpenAI's official endpoints**: `https://auth.openai.com` (issuer) and `https://chatgpt.com/backend-api/codex/responses` (Responses API). No code path sends tokens or keys to the ChatMock author or any third party.
- **No API keys to leak.** ChatMock does not use or store your Platform API key unless you explicitly use an exchanged token; it uses OAuth tokens (access/refresh) from the same flow as Codex. So you're not "exposing" a pay-per-use API key; you're using subscription auth.
- **Sensitive bits in code:** Login temporarily puts tokens in a **localhost redirect URL** (browser is sent to `http://localhost:1455/success?...` with tokens in the query string). That stays on your machine and in browser history; no remote server receives that URL. The auth file is plaintext (like Codex's `~/.codex/auth.json`); treat it like a password—don't commit or share it. `.gitignore` does not list that auth file (it's under the app's home dir, not in the repo), so normal cloning won't include your tokens.
- **Mac app:** The DMG/app is not signed with an Apple Developer ID, so Gatekeeper may block it; the README suggests `xattr -dr com.apple.quarantine` or "Open anyway." That's a trust/convenience tradeoff, not evidence of malware; you can instead run the Python server and avoid the app.

**Danger notes / caveats:**

- **Unofficial and "at your own risk."** Not affiliated with OpenAI; ToS for your ChatGPT account may treat automation differently.
- **Local server = local exposure.** If you bind to `0.0.0.0` or expose the port, anyone on the network could use your subscription; keep the server on `127.0.0.1` (default) for local projects only.
- **Token file:** Secure your home directory; anyone with read access to the ChatMock auth file can use your ChatGPT session until you revoke or re-login.

**Verdict for local projects:** Reasonable for personal/local use: open source, only talks to OpenAI, credentials local, no telemetry or exfiltration in the code we reviewed. Use a local-only binding and treat the auth file as sensitive.

---

## Summary

| Goal                         | Option        | How |
|-----------------------------|---------------|-----|
| Use API with pay-per-use    | Official API  | Add API key in Dashboard → Providers → OpenAI. |
| Use ChatGPT subscription   | ChatMock      | Run ChatMock, set OpenAI baseUrl to ChatMock (e.g. `http://127.0.0.1:8000/v1`), any API key. |

There is no official way to “use my OAuth ChatGPT account instead of API credits” for arbitrary API calls; ChatMock is the practical way to get subscription-based, API-compatible usage today.
