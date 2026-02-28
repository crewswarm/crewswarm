# Per-Task/Per-Agent Stop Controls Implementation

## Summary
Implemented individual stop controls for tasks and agents, allowing concurrent operations while maintaining the ability to cancel specific tasks independently.

## Key Changes

### 1. Task Manager (`frontend/src/core/task-manager.js`) - NEW
- Central singleton that tracks all active tasks
- Registers tasks with abort controllers
- Provides methods to:
  - Stop individual tasks
  - Stop all tasks for a specific agent
  - Stop all tasks globally
  - Query active tasks and agent busy status
- Pub/sub pattern for UI updates

### 2. Active Tasks Panel Component (`frontend/src/components/active-tasks-panel.js`) - NEW
- Displays a live panel of running tasks
- Shows for each task:
  - Agent/engine badge (color-coded)
  - Task description
  - Duration timer (updates every second)
  - Individual stop button
- "Stop All" button in panel header
- Auto-hides when no tasks active
- Appears above chat messages

### 3. Chat Actions Integration (`frontend/src/chat/chat-actions.js`) - MODIFIED
- Integrated TaskManager into `sendChat()` and `sendPassthrough()`
- Each message/operation registers with a unique task ID
- Tasks tracked with abort controllers
- Input no longer disabled during operations (allows concurrent sends)
- Send button stays green (no longer turns red during operation)
- Tasks auto-complete/fail/stop based on operation outcome

### 4. HTML Layout (`frontend/index.html`) - MODIFIED
- Added `<div id="activeTasksPanel">` above chat messages
- Moved emergency buttons ("⏹ Stop All", "☠️ Kill") to page header
- Made buttons smaller/less prominent (they're now for emergencies only)

### 5. App Initialization (`frontend/src/app.js`) - MODIFIED
- Imported `initActiveTasksPanel` component
- Initialize active tasks panel on DOMContentLoaded

## User Benefits

### ✅ Concurrent Operations
- Send multiple messages to crew-lead while others are processing
- Talk to different engines simultaneously
- Switch between agents/engines without waiting

### ✅ Granular Control
- Stop individual tasks without affecting others
- See all active operations at a glance
- Stop all tasks for a specific agent if needed

### ✅ Better UX
- No more blocking UI during operations
- Clear visibility of what's running
- Duration timers show how long tasks have been running
- Individual task descriptions for context

### ✅ Emergency Controls Still Available
- "Stop All" and "Kill All" moved to header
- Less prominent but still accessible
- Used only when needed (not the primary interaction)

## Technical Details

### Task ID Format
- Chat: `chat-{timestamp}`
- Passthrough: `passthrough-{engine}-{timestamp}`
- Ensures uniqueness across all task types

### Task Lifecycle
1. **Register**: Task created with abort controller
2. **Running**: Tracked in TaskManager, shown in UI
3. **Complete/Fail/Stop**: Task removed, listeners notified
4. **UI Update**: Panel re-renders on any state change

### Abort Controller Flow
```javascript
const controller = new AbortController();
taskManager.registerTask(taskId, { agent, description, controller });
try {
  await operation(controller.signal);
  taskManager.completeTask(taskId);
} catch (e) {
  if (e.name === 'AbortError') {
    taskManager.stopTask(taskId); // User cancelled
  } else {
    taskManager.failTask(taskId, e.message);
  }
}
```

## Future Enhancements

### Possible Additions
- Task history/log (show completed tasks)
- Pause/resume support (where applicable)
- Task priority indicators
- Estimated completion time
- Progress bars for long-running operations
- Group by agent/engine
- Filter active tasks by type
- Export task logs

### Integration Points
- PM Loop tasks (mark roadmap items)
- Pipeline wave tracking
- RT bus agent status
- Build/test runs
- File operations

## Testing Checklist

- [x] Task manager tracks tasks correctly
- [x] Active tasks panel renders and updates
- [x] Individual stop buttons work
- [x] Stop all button works
- [x] Concurrent chat messages work
- [x] Concurrent passthrough operations work
- [x] Task durations update every second
- [x] Panel auto-hides when empty
- [x] UI doesn't block during operations
- [ ] Test with PM Loop integration (future)
- [ ] Test with pipeline dispatches (future)
- [ ] Verify no memory leaks on long sessions
