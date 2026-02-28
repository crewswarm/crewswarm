# UI Improvement: Send Button Always "Send"

## Changes Made

### 1. Moved Emergency Buttons to Bottom Row
**Before:** Stop All and Kill buttons were in the page header  
**After:** Moved to the bottom control row (right-aligned, next to engine/model selectors)

**Why:** 
- Send button should always say "Send" (clearer UX)
- Emergency controls grouped together at the bottom
- Less visual clutter in header

### 2. Button Layout

**Top (Header):**
```
● crew-lead offline   [🗑 Clear]
```

**Bottom (Controls Row):**
```
[Project] [Engine] [Model] [History] [● Session]  |  [⏹ Stop All] [☠️ Kill Agents]
```

### 3. Behavior

- **Send Button:** Always shows "Send", never changes
- **Stop All:** Stops all running pipelines (agents stay online)
- **Kill Agents:** Emergency kill all agent processes
- **Stop buttons in Active Tasks Panel:** Individual task control

### 4. Active Tasks Panel

The Active Tasks Panel (above chat) provides per-task control:
- Shows all running tasks
- Individual stop button for each task
- "Stop All" button in panel header

**This gives users 3 levels of control:**
1. **Granular:** Stop individual tasks (Active Tasks Panel)
2. **Moderate:** Stop all pipelines (⏹ Stop All button)
3. **Nuclear:** Kill all agents (☠️ Kill Agents button)

---

## Files Modified

- `frontend/index.html` - Moved buttons, always show "Send"
- `frontend/src/chat/chat-actions.js` - Added `resetSendButton()` helper
- `frontend/src/app.js` - Use `resetSendButton()` on engine/model change

---

## To See Changes

**Hard refresh the dashboard:**
```
Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows/Linux)
```

**Expected Result:**
- Send button always says "Send"
- Emergency buttons at bottom right
- Cleaner, more intuitive layout
