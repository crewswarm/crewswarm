# Telegram Mini App UI (Control Deck)

This is a Telegram Mini App front-end scaffold for CrewSwarm operations.

## Files

- `index.html` — App shell + Telegram WebApp SDK include
- `styles.css` — Mobile-first UI styling
- `app.js` — State management + payload send logic

## What it supports

- Mode selection: `chat`, `direct`, `bypass`
- Engine selection: `cursor`, `claude`, `codex`, `opencode`
- Agent selection (`crew-main`, `crew-coder`, etc.)
- Project selection (from injected global list)
- Quick action templates
- `Telegram.WebApp.sendData()` payloads for backend routing
- Payload preview panel for debugging

## Payload shape sent via `sendData`

```json
{
  "type": "crew_miniapp",
  "action": "message",
  "mode": "direct",
  "engine": "cursor",
  "agent": "crew-main",
  "projectId": "my-project",
  "prompt": "hi",
  "ts": "2026-02-28T00:00:00.000Z"
}
```

## Injecting projects

Set this before app boot:

```html
<script>
  window.CREW_MINIAPP_PROJECTS = [
    { id: "ops-core", name: "Ops Core" },
    { id: "website", name: "Marketing Website" }
  ];
</script>
```

## Integration notes

- In Telegram bridge callback or webhook handler, parse `sendData` JSON.
- Route by `mode`:
  - `chat` -> crew-lead chat path
  - `direct` -> engine passthrough path
  - `bypass` -> dispatch with direct+bypass flags
- Persist state by `chatId` to keep controls sticky across messages.

## Next step

Once parent-repo write access is available, wire this UI into Telegram bot menu button (`setChatMenuButton`) and process incoming WebApp data in `telegram-bridge.mjs`.
