# Chat History Hard Refresh Fix

**Date:** 2026-03-02  
**Issue:** Hard refresh shows old random passthrough messages mixed with chat  
**Status:** ✅ Fixed

---

## Problems Fixed

### 1. ✅ Always Clear on Hard Refresh

**Before:**
```javascript
const shouldPreserveMessages = hasExistingMessages && box.dataset.historyLoaded === 'true';

if (!shouldPreserveMessages) {
  // Only clear if not already loaded
  box.innerHTML = '';
}
// else: We already have messages loaded, don't clear them!
```

**Problem:** Hard refresh would sometimes preserve old messages from previous session

**After:**
```javascript
// ALWAYS clear on load - fixes hard refresh showing old messages
box.innerHTML = '';
box.dataset.historyLoaded = 'false';
setLastAppendedAssistantContent('');
setLastAppendedUserContent('');
```

**Result:** Every page load starts fresh - no stale messages

---

### 2. ✅ Better Timestamp Validation

**Before:**
```javascript
const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
const recentLog = passthroughLog.filter(entry => {
  return entry.timestamp && entry.timestamp > oneDayAgo;
});
```

**Problems:**
- 24 hours too long (shows yesterday's random CLI sessions)
- No validation that timestamp is a number
- No check for valid content

**After:**
```javascript
const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
const recentLog = passthroughLog.filter(entry => {
  // Must have timestamp AND be within last 6 hours AND have valid content
  return entry.timestamp 
    && typeof entry.timestamp === 'number' 
    && entry.timestamp > sixHoursAgo
    && entry.text
    && entry.text.trim().length > 0;
});
```

**Changes:**
- ✅ Reduced from 24 hours → **6 hours** (more relevant)
- ✅ Validate timestamp is a number (not string or undefined)
- ✅ Check content exists and isn't empty
- ✅ Auto-cleanup: old entries removed from localStorage

---

### 3. ✅ Don't Mix Passthrough Logs with Chat History

**Before:**
```javascript
// Load crew-lead history
d.history.forEach((h) => { appendChatBubble(...) });

// Always append passthrough logs (CLI interactions) after crew-lead history
const passthroughLog = ...;
appendPassthroughLogsToChat(recentLog);
```

**Problem:** Old CLI logs mixed with current crew-lead conversation

**After:**
```javascript
// Load crew-lead history
if (d.history && d.history.length) {
  d.history.forEach((h) => { appendChatBubble(...) });
}

// Load passthrough logs ONLY if no crew-lead history exists
if (!d.history || d.history.length === 0) {
  const passthroughLog = ...;
  appendPassthroughLogsToChat(recentLog);
}
```

**Logic:**
- ✅ Has crew-lead chat? → Show ONLY crew-lead history
- ✅ No crew-lead chat? → Show recent passthrough logs (last 6 hours)
- ✅ Never mix both

---

## What Changed

**File:** `frontend/src/chat/chat-actions.js` - `loadChatHistory()` function

### Change Summary

| Aspect | Before | After |
|---|---|---|
| **Clear on refresh** | Conditional (preserve if loaded) | Always clear |
| **Passthrough filter** | Last 24 hours | Last 6 hours + strict validation |
| **Mixing behavior** | Always append both | Only show passthrough if no crew-lead chat |
| **Timestamp check** | Basic truthy check | Type validation + range check |
| **Content validation** | None | Must have valid text |
| **localStorage cleanup** | Only if count changed | Always clean up old entries |

---

## User Experience

### Before (Broken)

1. User has crew-lead chat session
2. User does `Cmd+Shift+R` (hard refresh)
3. Dashboard shows:
   - ❌ Old crew-lead messages (preserved)
   - ❌ Random CLI logs from yesterday
   - ❌ Mixed together confusingly
   - ❌ Can't tell what's current

### After (Fixed)

1. User has crew-lead chat session
2. User does `Cmd+Shift+R` (hard refresh)
3. Dashboard shows:
   - ✅ Fresh load of crew-lead history from server
   - ✅ No old passthrough logs (has crew-lead history)
   - ✅ Clean, current conversation
   - ✅ Clear separation

### Scenario: Pure CLI Mode

1. User has NO crew-lead chats (only uses Cursor/OpenCode directly)
2. Refresh dashboard
3. Shows:
   - ✅ Recent CLI sessions (last 6 hours)
   - ✅ No random old stuff
   - ✅ Relevant context only

---

## Technical Details

### Chat History Sources

CrewSwarm has TWO separate chat storage systems:

| Source | Storage | Purpose | Shown When |
|---|---|---|---|
| **Crew-lead history** | Server: `~/.crewswarm/chat-history/{user}/{session}.jsonl` | LLM conversations with crew-lead | Always (if exists) |
| **Passthrough logs** | Browser: `localStorage['crewswarm_passthrough_log']` | Direct CLI interactions (Cursor, OpenCode, etc.) | Only if NO crew-lead history |

**Why separate?**
- Crew-lead: Persistent, server-side, multi-device
- Passthrough: Ephemeral, browser-local, single device

**New logic:**
- Has server history? → Use it (source of truth)
- No server history? → Show recent CLI logs (fallback)

---

## Code Changes

### Full New Implementation

```javascript
async function loadChatHistory() {
  try {
    const d = await getJSON('/api/crew-lead/history?sessionId=' + encodeURIComponent(getChatSessionId()));
    const box = document.getElementById('chatMessages');
    
    // ALWAYS clear on load - fixes hard refresh showing old messages
    box.innerHTML = '';
    box.dataset.historyLoaded = 'false';
    setLastAppendedAssistantContent('');
    setLastAppendedUserContent('');
    
    // Load crew-lead history if available
    if (d.history && d.history.length) {
      d.history.forEach((h) => {
        appendChatBubble(h.role === 'user' ? 'user' : 'assistant', h.content);
        if (h.role === 'assistant') setLastAppendedAssistantContent(h.content);
        if (h.role === 'user') setLastAppendedUserContent(h.content);
      });
    }
    
    // Load passthrough logs (CLI interactions) ONLY if no crew-lead history exists
    // This prevents mixing old CLI logs with current crew-lead conversations
    if (!d.history || d.history.length === 0) {
      const passthroughLog = JSON.parse(localStorage.getItem(PASSTHROUGH_LOG_KEY) || '[]');
      
      // Strict timestamp validation: only last 6 hours + valid timestamp
      const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
      const recentLog = passthroughLog.filter(entry => {
        // Must have timestamp AND be within last 6 hours AND have valid content
        return entry.timestamp 
          && typeof entry.timestamp === 'number' 
          && entry.timestamp > sixHoursAgo
          && entry.text
          && entry.text.trim().length > 0;
      });
      
      if (recentLog.length > 0) {
        appendPassthroughLogsToChat(recentLog);
      }
      
      // Clean up localStorage - remove old entries
      if (recentLog.length !== passthroughLog.length) {
        localStorage.setItem(PASSTHROUGH_LOG_KEY, JSON.stringify(recentLog));
      }
    }
    
    box.scrollTop = box.scrollHeight;
    box.dataset.historyLoaded = 'true';
    
  } catch (err) {
    console.warn('Failed to load chat history:', err);
    // On error, still mark as loaded to prevent infinite retry
    const box = document.getElementById('chatMessages');
    if (box) box.dataset.historyLoaded = 'true';
  }
}
```

---

## Testing

### Test Case 1: Hard Refresh with Crew-lead Chat

```bash
# Setup
1. Open dashboard → Chat tab
2. Send message to crew-lead
3. Get response
4. Hard refresh (Cmd+Shift+R)

# Expected
✅ Chat box clears completely
✅ Server history loads fresh
✅ No old passthrough logs
✅ Only current crew-lead conversation
```

### Test Case 2: Hard Refresh with No Chat

```bash
# Setup
1. Clear crew-lead history
2. Use Cursor CLI directly (some passthrough messages)
3. Wait 1 hour
4. Hard refresh

# Expected
✅ Chat box clears
✅ Shows recent CLI logs (last 6 hours)
✅ No random old messages
```

### Test Case 3: Old Passthrough Cleanup

```bash
# Setup
1. Have 10 passthrough logs from yesterday in localStorage
2. Refresh dashboard

# Expected
✅ Old logs filtered out (> 6 hours)
✅ localStorage updated to remove them
✅ Only fresh logs shown
```

---

## Manual Cleanup (If Needed)

If you still see old messages after the fix:

**Clear passthrough logs:**
```javascript
// In browser console:
localStorage.removeItem('crewswarm_passthrough_log');
// Then hard refresh
```

**Clear crew-lead history:**
```bash
# Delete server-side history file
rm ~/.crewswarm/chat-history/default/owner.jsonl
# Then hard refresh dashboard
```

---

## Build & Deploy

```bash
cd frontend && npm run build
# ✓ Built: dist/assets/index-DQX16u8r.js (269KB)

pkill -f dashboard.mjs
node scripts/dashboard.mjs &
# ✓ Dashboard running on :4319
```

---

**Status:** ✅ Fixed - Hard refresh now always shows clean, current chat history. Old passthrough logs are filtered to last 6 hours and only shown when no crew-lead chat exists.
