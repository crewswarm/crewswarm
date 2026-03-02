# Tasks Panel Fix - Only Show Agent Tasks

## Issue
When returning to chat, tasks disappeared. Also, **every chat message was showing as a task** in the Tasks panel at the top of the Chat tab.

## Root Cause
In `frontend/src/chat/chat-actions.js`, both:
1. **`sendChat()`** (lines 228-233) - Regular crew-lead chat messages
2. **`sendPassthrough()`** (lines 446-451) - CLI passthrough (OpenCode, Cursor, etc.)

Were calling `taskManager.registerTask()`, which added every chat interaction to the tasks panel.

**The tasks panel should ONLY show actual agent dispatch tasks**, not chat messages or CLI interactions.

## Fix Applied

**Commented out all `taskManager` calls in chat/passthrough flows:**

### Regular Chat (lines 228-291)
```javascript
// BEFORE: Registered every chat message as a task
taskManager.registerTask(taskId, {
  agent: 'crew-lead',
  type: 'chat',
  description: text.slice(0, 60) + '...',
  controller,
});

// AFTER: Don't register chat messages
// taskManager.registerTask(taskId, { ... });
```

### CLI Passthrough (lines 442-520)
```javascript
// BEFORE: Registered every CLI message as a task
taskManager.registerTask(taskId, {
  agent: engineLabels[engine] || engine,
  type: 'passthrough',
  description: text.slice(0, 60) + '...',
  controller,
});

// AFTER: Don't register CLI messages
// taskManager.registerTask(taskId, { ... });
```

## What Shows in Tasks Panel Now

**✅ ONLY actual agent tasks:**
- Dispatched agents (e.g., "dispatch crew-coder to fix bug")
- Pipeline tasks (e.g., wave 1: crew-coder, wave 2: crew-qa)
- Autonomous PM loop tasks
- Background agent work

**❌ NOT chat messages:**
- Regular chat with crew-lead
- CLI passthrough (OpenCode, Cursor, Gemini CLI, etc.)
- User questions and responses

## Why Tasks "Disappeared"

The tasks panel retention logic (5 minutes) was working correctly. The issue was that **chat messages were incorrectly being tracked as tasks**, so when you switched tabs and came back:
1. Old "chat tasks" expired (5min retention)
2. New chat messages weren't actual tasks
3. Panel appeared empty

Now the panel only shows **real agent work**, not conversations.

## Benefits

1. **Cleaner UI** - Tasks panel only shows actual work being done by agents
2. **Better UX** - No confusion between "chatting" and "dispatching work"
3. **Accurate tracking** - Task durations and status only for real agent tasks
4. **Persistence** - Real tasks persist correctly, chat history is separate

## Testing

1. ✅ Send a regular chat message → No task appears
2. ✅ Send a CLI passthrough (OpenCode/Cursor) → No task appears
3. ✅ Dispatch an agent (`dispatch crew-coder to...`) → Task appears ✅
4. ✅ Switch tabs and come back → Real tasks still visible
5. ✅ Chat history persists separately (last 24 hours in localStorage)

## Files Modified

- `frontend/src/chat/chat-actions.js` (commented out 8 `taskManager` calls)
- `frontend/dist/` (rebuilt)

## Architecture Note

**Task sources (should appear in panel):**
- `@@DISPATCH` commands → Real agent tasks
- `@@PIPELINE` commands → Multi-wave agent tasks
- PM loop autonomous execution → Roadmap tasks
- Agent-to-agent delegation → Sub-tasks

**NOT task sources (chat only):**
- Regular chat messages to crew-lead
- CLI passthrough (OpenCode/Cursor/Gemini/Codex)
- User questions and responses
- `@@BRAIN`, `@@MEMORY`, other non-dispatch commands

The `TaskManager` is now exclusively for tracking **agent execution**, not conversations.

## Status

✅ **FIXED** - Tasks panel now only shows actual agent dispatch tasks.

Chat and CLI passthrough messages are properly tracked in chat history but don't clutter the tasks panel.
