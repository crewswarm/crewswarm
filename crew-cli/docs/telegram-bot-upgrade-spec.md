# Telegram Bot Upgrade Spec (Buttons + State + Fallback + Mini App path)

Date: 2026-02-28  
Target file: `telegram-bridge.mjs` (main CrewSwarm repo root)

## Scope

1. Fix passthrough result semantics (`exit != 0` => error UI).
2. Add button menus + callback state (`mode`, `engine`, `agent`, `project` per chat).
3. Add auto-fallback + retry buttons on quota/rate-limit/empty output.
4. Define Mini App follow-up that builds on the same state/backend.

## Constraint in this session

`crew-cli` workspace cannot write parent repo files (sandbox denied for `../telegram-bridge.mjs`).  
Use this spec to patch main repo directly.

## A. Data model to add

Add near existing session maps:

```js
const chatState = new Map(); // chatId -> { mode, engine, agent, projectId, lastPrompt, lastEngine, lastErrorType }
const pendingInput = new Map(); // chatId -> { kind: "engine_prompt"|"agent_task", value: string }

const DEFAULT_STATE = {
  mode: "chat",          // chat | direct | bypass
  engine: "cursor",      // cursor | claude | codex | opencode
  agent: "crew-main",
  projectId: null,
  lastPrompt: "",
  lastEngine: "",
  lastErrorType: ""
};

function getState(chatId) {
  return { ...DEFAULT_STATE, ...(chatState.get(chatId) || {}) };
}
function setState(chatId, patch) {
  const next = { ...getState(chatId), ...patch };
  chatState.set(chatId, next);
  return next;
}
```

## B. Telegram API helpers to add

```js
async function tgAnswerCallbackQuery(callbackQueryId, text = "") {
  try {
    await tgRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text.slice(0, 180) || undefined,
      show_alert: false
    });
  } catch {}
}

async function tgEdit(chatId, messageId, text, replyMarkup) {
  await tgRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "Markdown",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }).catch(() => tgRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }));
}
```

## C. Main menu (reply keyboard) and inline menus

```js
function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "Chat crew-main" }, { text: "Direct engine" }, { text: "Bypass mode" }],
      [{ text: "Set engine" }, { text: "Set agent" }, { text: "Projects" }],
      [{ text: "Status" }, { text: "Help" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function engineInline() {
  return {
    inline_keyboard: [
      [{ text: "Cursor", callback_data: "eng:cursor" }, { text: "Claude", callback_data: "eng:claude" }],
      [{ text: "Codex", callback_data: "eng:codex" }, { text: "OpenCode", callback_data: "eng:opencode" }]
    ]
  };
}

function modeInline() {
  return {
    inline_keyboard: [
      [{ text: "Chat", callback_data: "mode:chat" }, { text: "Direct", callback_data: "mode:direct" }, { text: "Bypass", callback_data: "mode:bypass" }]
    ]
  };
}
```

At startup (after `getMe`) call:

```js
await tgRequest("setMyCommands", {
  commands: [
    { command: "menu", description: "Show quick menu" },
    { command: "mode", description: "Select chat/direct/bypass mode" },
    { command: "engine", description: "Select direct engine" },
    { command: "agent", description: "Select target agent" },
    { command: "projects", description: "List projects" },
    { command: "status", description: "Show current state" }
  ]
});
```

When user sends `/menu`, send a message with `reply_markup: mainReplyKeyboard()`.

## D. Handle callback queries

In `pollLoop`, change:

```js
allowed_updates: ["message", "callback_query"]
```

Inside update loop:

```js
if (update.callback_query) {
  await handleCallback(update.callback_query);
  continue;
}
```

Add handler:

```js
async function handleCallback(q) {
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  const data = String(q.data || "");
  if (!chatId) return;

  if (q.id) await tgAnswerCallbackQuery(q.id, "Updated");

  if (data.startsWith("mode:")) {
    const mode = data.slice(5);
    const next = setState(chatId, { mode });
    if (messageId) await tgEdit(chatId, messageId, `Mode set to *${next.mode}*`, modeInline());
    return;
  }

  if (data.startsWith("eng:")) {
    const engine = data.slice(4);
    const next = setState(chatId, { engine, mode: "direct" });
    if (messageId) await tgEdit(chatId, messageId, `Engine set to *${next.engine}* (mode: direct)`, engineInline());
    return;
  }

  if (data.startsWith("retry:last")) {
    const st = getState(chatId);
    if (!st.lastPrompt) {
      await tgSend(chatId, "No last prompt found.");
      return;
    }
    await routeByState(chatId, st.lastPrompt);
    return;
  }

  if (data.startsWith("fallback:main")) {
    setState(chatId, { mode: "chat", agent: "crew-main" });
    const st = getState(chatId);
    await tgSend(chatId, "Switched to chat -> crew-main fallback.");
    if (st.lastPrompt) await routeByState(chatId, st.lastPrompt);
    return;
  }
}
```

## E. Fix passthrough semantics + fallback

Replace `handleEnginePassthrough` done-event logic:

```js
function classifyEngineFailure(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many requests")) return "rate_limit";
  if (s.includes("hit your limit") || s.includes("quota") || s.includes("billing")) return "quota_limit";
  if (s.includes("auth") || s.includes("token") || s.includes("unauthorized")) return "auth";
  if (s.includes("no text output")) return "empty_output";
  return "generic";
}

function errorInline() {
  return {
    inline_keyboard: [
      [{ text: "Retry", callback_data: "retry:last" }, { text: "Fallback crew-main", callback_data: "fallback:main" }],
      [{ text: "Set engine", callback_data: "open:engine" }, { text: "Set mode", callback_data: "open:mode" }]
    ]
  };
}
```

In done branch:

```js
if (d.type === "done") {
  const exitCode = d.exitCode ?? 0;
  const body = fullText.trim();
  if (exitCode !== 0) {
    const failText = body || "(no output returned)";
    const kind = classifyEngineFailure(failText);
    setState(chatId, { lastErrorType: kind });
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `❌ ${label} failed (exit ${exitCode})\n\n${failText.slice(0, 2000)}`,
      reply_markup: errorInline()
    });
    return;
  }
  if (!body) {
    setState(chatId, { lastErrorType: "empty_output" });
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: `⚠️ ${label} completed with no text output.`,
      reply_markup: errorInline()
    });
    return;
  }
  await tgSend(chatId, `✅ ${label} (exit 0)\n\n${body}`);
  return;
}
```

## F. Unified routing by chat state

Add:

```js
async function routeByState(chatId, text) {
  const st = setState(chatId, { lastPrompt: text, lastEngine: getState(chatId).engine });
  if (st.mode === "direct") {
    await handleEnginePassthrough(chatId, st.engine, text);
    return;
  }
  if (st.mode === "bypass") {
    await dispatchTask(chatId, st.agent || "crew-main", text, { direct: true, bypass: true, engine: st.engine });
    return;
  }
  await dispatchChat(chatId, text, st.agent || "crew-main");
}
```

Then in message processing, if not slash command: call `routeByState(chatId, text)` instead of hardcoded `/chat` send.

## G. Mini App roadmap (after buttons stabilize)

Mini App should reuse the same chat state + backend routes:

- Reuse state keys: `mode`, `engine`, `agent`, `projectId`.
- Reuse operations: `routeByState`, `/api/dispatch`, `/api/engine-passthrough`.
- Add a tiny web app with:
  - mode/engine/agent selectors
  - active jobs list
  - last errors + retry actions

Do **not** start with Mini App first; button UX gives fast validation and lower operational risk.

## H. Acceptance checklist

- [ ] `exit 1` now renders as `❌`, never `✅`.
- [ ] Empty output gives warning + retry/fallback buttons.
- [ ] Quota/rate-limit errors present engine-switch + fallback.
- [ ] `/menu` shows keyboard; callbacks update state and acknowledge quickly.
- [ ] Regular message follows selected mode without typing command prefixes.
- [ ] Callback data kept under 64 bytes.

