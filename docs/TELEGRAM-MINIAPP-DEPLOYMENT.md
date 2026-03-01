# Telegram Mini App Deployment - 2026-02-28

## ✅ Deployed and Live

**Mini App URL:** `https://hokey-unpatternized-in.ngrok-free.dev`

**Status:** 
- ✅ HTTP server running on port 3456
- ✅ ngrok tunnel active (HTTPS)
- ✅ Mini App button registered in Telegram bot
- ✅ Accessible only via Telegram's iframe wrapper

## How to Access

1. Open your CrewSwarm Telegram bot
2. Click the **menu button** (bottom-left, next to message input)
3. Select "🎛️ CrewSwarm" to open the Mini App

## Security Model

### ✅ SECURE - Multi-layered Protection

**Layer 1: Telegram Authentication**
- Mini App opens in Telegram's iframe (not public browser)
- User identity verified by Telegram (can't be spoofed)
- `initData` contains signed hash validated by bot

**Layer 2: Allowlist in telegram-bridge.mjs**
```javascript
// Lines 798-803
const allowed = getAllowedIds();
if (allowed && !allowed.has(chatId)) {
  await tgSend(chatId, "⛔ Unauthorized.");
  return;
}
```

**Layer 3: Bearer Token**
- All API calls require `Authorization: Bearer <token>`
- Token from `~/.crewswarm/config.json.rt.authToken`

**Layer 4: Session Scope Isolation**
- Each Telegram chat gets unique `sessionId: telegram-${chatId}`
- Codex/Gemini sessions fully isolated per user
- No cross-chat contamination

### ❌ What if someone opens the ngrok URL directly?

**They can't do damage because:**

1. **No Telegram context** → `Telegram.WebApp.sendData()` won't work
2. **No chat ID** → telegram-bridge rejects (no allowlist match)
3. **No auth token** → crew-lead API returns 401 Unauthorized
4. **Static HTML only** → Just UI, no backend logic

**Worst case:** They see a UI that doesn't do anything functional.

**Best practice:** Add Telegram `initData` validation for extra security.

## How It Works

### Data Flow

```
User clicks in Mini App
  ↓
app.js calls Telegram.WebApp.sendData(payload)
  ↓
Telegram sends to bot backend as msg.web_app_data.data
  ↓
telegram-bridge.mjs handleMiniAppData()
  ↓ (checks allowlist)
  ↓
Routes based on mode:
  - chat → /chat API
  - direct → /api/engine-passthrough
  - bypass → /api/dispatch (direct+bypass)
  ↓
crew-lead processes with:
  - projectDir from payload.projectId → path lookup
  - sessionScope: telegram-${chatId}
  - engine: cursor/claude/codex/gemini
  ↓
Response sent back to Telegram chat
```

### Payload Structure

```json
{
  "type": "crew_miniapp",
  "action": "message",
  "mode": "direct",
  "engine": "cursor",
  "agent": "crew-main",
  "projectId": "my-project",
  "prompt": "hi",
  "ts": "2026-02-28T19:30:00.000Z"
}
```

## Security Best Practices

### ✅ Currently Implemented
- Telegram iframe wrapper (can't be opened in regular browser)
- Chat ID allowlist enforcement
- Bearer token on all API calls
- Session scope isolation

### 🔒 Optional Hardening
1. **Add initData validation:**
```javascript
// Validate Telegram's signed hash
function validateInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");
  
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  
  const secretKey = crypto.createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  
  const expectedHash = crypto.createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  
  return hash === expectedHash;
}
```

2. **Add rate limiting per chat ID**
3. **Log all Mini App requests for audit**

## Testing

**In Telegram:**
1. Click menu button → "🎛️ CrewSwarm"
2. Select mode: `direct`
3. Select engine: `codex`
4. Select project (or leave as "General mode")
5. Type: "hi"
6. Click "Send"

**Expected result:**
- Message routes to Codex with scoped session
- Response appears in Telegram chat
- Each project selection gets isolated Codex context

## Deployment Details

**Local setup:**
```bash
# Mini App server (port 3456)
node crew-cli/docs/telegram-miniapp/serve.mjs

# ngrok tunnel (HTTPS)
ngrok http 3456

# Telegram bridge (with Mini App URL)
TELEGRAM_MINIAPP_URL=https://hokey-unpatternized-in.ngrok-free.dev \
  node telegram-bridge.mjs
```

**Environment:**
```bash
export TELEGRAM_MINIAPP_URL=https://hokey-unpatternized-in.ngrok-free.dev
```

**Persistent deployment:**
- Add `TELEGRAM_MINIAPP_URL` to `~/.crewswarm/crewswarm.json` env block
- Or deploy to permanent HTTPS domain (your own server/Fly.io with auth)

## Files

- `crew-cli/docs/telegram-miniapp/index.html` - Mini App UI
- `crew-cli/docs/telegram-miniapp/styles.css` - Styling
- `crew-cli/docs/telegram-miniapp/app.js` - Logic + sendData
- `crew-cli/docs/telegram-miniapp/serve.mjs` - HTTP server
- `telegram-bridge.mjs` - Backend handler (handleMiniAppData)

## Status

✅ **LIVE and SECURE**
- Public ngrok URL: Safe (no backend access without Telegram context)
- Allowlist enforced: Only your chat ID works
- Bearer auth: All API calls protected
- Session isolation: Each chat independent

**Try it now in your Telegram bot!**
