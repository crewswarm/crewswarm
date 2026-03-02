# User/Session Isolation Migration

## Changes Applied

### 1. Core History Functions (`lib/chat/history.mjs`)

Updated all functions to accept `userId` as the first parameter:

- `sessionFile(userId, sessionId)` - Returns user-scoped file path
- `loadHistory(userId, sessionId)` - Loads user-specific history
- `appendHistory(userId, sessionId, role, content)` - Appends to user history
- `clearHistory(userId, sessionId)` - Clears user history
- `listUserSessions(userId)` - NEW: List all sessions for a user

**File structure:** `~/.crewswarm/chat-history/{userId}/{sessionId}.jsonl`

### 2. Chat Handler (`lib/crew-lead/chat-handler.mjs`)

Updated `handleChat` signature to accept `userId`:

```javascript
export async function handleChat({ 
  message, 
  sessionId = "default", 
  userId = "default",  // NEW
  firstName = "User", 
  projectId = null 
})
```

Updated memory recall to include userId:

```javascript
memoryContext = await recallMemoryContext(projectDir, 'session initialization chat context', {
  maxResults: 8,
  includeDocs: true,
  includeCode: false,
  preferSuccessful: true,
  crewId: 'crew-lead',
  userId: userId  // NEW: user-scoped memory
});
```

### 3. HTTP API Endpoints (`lib/crew-lead/http-server.mjs` and `crew-lead.mjs`)

Need to update all chat endpoints to extract and pass `userId`:

**Dashboard chat** - extract from session cookie or auth header
**Telegram bridge** - use Telegram chat ID as userId
**WhatsApp bridge** - use WhatsApp phone number as userId
**Direct API calls** - require userId in request body

### 4. Memory System (`lib/memory/shared-adapter.mjs`)

Updated `recallMemoryContext` to accept `userId` in options and filter results:

```javascript
export async function recallMemoryContext(projectDir, query, options = {}) {
  const userId = options.userId || 'default';
  // Filter memory entries by userId
  // ...
}
```

### 5. Shared Memory Storage

AgentMemory entries now include userId:

```json
{
  "userId": "telegram:123456789",
  "agentId": "crew-lead",
  "key": "preference:language",
  "value": "TypeScript",
  "createdAt": "2026-03-01T..."
}
```

AgentKeeper task results include userId:

```json
{
  "taskId": "abc123",
  "userId": "dashboard:admin",
  "agentId": "crew-coder",
  "result": "...",
  "status": "success"
}
```

## Migration Path

### Phase 1: Core Infrastructure (DONE)
- ✅ Update history.mjs functions
- ✅ Update chat-handler.mjs signature
- ✅ Update memory recall to include userId

### Phase 2: API Integration (IN PROGRESS)
- [ ] Update HTTP server to extract userId from requests
- [ ] Update Telegram bridge to use chat ID as userId
- [ ] Update WhatsApp bridge to use phone number as userId
- [ ] Add userId to all SSE events

### Phase 3: Memory System (PENDING)
- [ ] Update AgentMemory to filter by userId
- [ ] Update AgentKeeper to filter by userId
- [ ] Add migration script to backfill existing data with default userId

### Phase 4: Dashboard UI (PENDING)
- [ ] Add user selector dropdown (for admin view)
- [ ] Show current userId in header
- [ ] Add per-user session list

## Backward Compatibility

All functions default `userId = "default"` so existing code continues to work.

Existing history files in `~/.crewswarm/chat-history/*.jsonl` are treated as belonging to the "default" user.

Migration script will move them to `~/.crewswarm/chat-history/default/*.jsonl`.

## Testing

```bash
# Test user-scoped history
node -e "import('./lib/chat/history.mjs').then(h => {
  h.appendHistory('user1', 'session1', 'user', 'Hello from user 1');
  h.appendHistory('user2', 'session1', 'user', 'Hello from user 2');
  console.log('User 1:', h.loadHistory('user1', 'session1'));
  console.log('User 2:', h.loadHistory('user2', 'session1'));
})"
```

## Security Considerations

1. **User ID sanitization** - Already implemented in `sanitizeId()` 
2. **Path traversal prevention** - IDs are sanitized, can't contain `/` or `..`
3. **Authorization** - Need to add userId validation in HTTP endpoints
4. **Admin access** - Dashboard admin should see all users, regular users only see their own

## Next Steps

1. Update all `appendHistory` calls in chat-handler.mjs to use userId
2. Update HTTP endpoints to extract userId from auth
3. Update Telegram/WhatsApp bridges to pass userId
4. Add userId to RT bus messages for proper isolation
