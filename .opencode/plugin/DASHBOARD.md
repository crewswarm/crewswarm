# OpenCode Swarm Dashboard

A simple HTML dashboard and relay script for monitoring OpenCode swarm agent sessions.

## Components

### 1. `dashboard.html`

A real-time dashboard that displays all active OpenCode sessions with auto-refresh.

**Features:**
- Polls the OpenCode server at `http://127.0.0.1:4096/session` every 5 seconds
- Shows all active sessions with:
  - Session ID
  - Task title/description
  - Agent type (extracted from title or slug)
  - Role (primary agent or subagent)
  - When the session was created (relative time)
- Clean, dark-themed UI with auto-refresh indicator
- Live connection status display
- Error handling with user-friendly messages

**Authentication:**
- Uses HTTP Basic Auth with credentials: `opencode:opencode`

**How to use:**
1. Open `dashboard.html` in a web browser
2. The dashboard will immediately fetch and display all active sessions
3. Auto-refresh happens every 5 seconds (shows in the header)
4. Hover over session cards for visual feedback

**Visual Indicators:**
- Primary agents: Blue left border + "PRIMARY" badge
- Subagents: Orange left border + "SUBAGENT" badge
- Cyan pulse indicator in header shows real-time status

### 2. `relay.sh`

A shell script to update OpenCode session titles with structured information.

**Purpose:**
- Sets clear, descriptive session titles that include task description and agent role
- Helps distinguish between primary agents and subagents
- Subagent titles include a session ID reference for tracking

**Usage:**
```bash
./relay.sh <session_id> <task_description> [role]
```

**Arguments:**
- `session_id`: The OpenCode session ID (e.g., `ses_abc123def456`)
- `task_description`: A clear description of what the agent is doing
- `role`: Either `primary` (default) or `subagent`

**Examples:**

Primary agent working on a task:
```bash
./relay.sh ses_38c0887bdffe2JzKp2NvV4hrOZ "Build agent dashboard UI" primary
```

Subagent spawned to help with a task:
```bash
./relay.sh ses_38c08ad9cffeiQjoEArqhnLLgH "Fetch dashboard UI file list" subagent
```

Result: Title becomes `"Fetch dashboard UI file list (@38c08ad9 subagent)"`

**Output:**
- Colored log messages showing success or errors
- Green `[INFO]` for successful updates
- Red `[ERROR]` for failures
- Yellow `[WARN]` for warnings

## Integration

### In Agent Code

When spawning a subagent, update its session title:

```bash
# After creating a subagent session
~/swarm/.opencode/plugin/relay.sh "$SESSION_ID" "Description of subagent task" subagent
```

### In OpenCode Plugin

The dashboard can be embedded in OpenCode's plugin system or served as a standalone page:

**Standalone:**
- Host the `dashboard.html` file on a web server
- Access via browser at that server's URL

**Within OpenCode UI:**
- Copy `dashboard.html` to your plugin's static assets
- Reference it from your plugin configuration

## Technical Details

### API Endpoint

The dashboard communicates with:
- **URL:** `http://127.0.0.1:4096/session`
- **Method:** GET
- **Auth:** HTTP Basic (`opencode:opencode`)
- **Response:** JSON array of session objects

### Session Data Structure

Each session contains:
```json
{
  "id": "ses_xxx",
  "slug": "agent-name",
  "title": "Task description",
  "parentID": "ses_parent_xxx",  // Only present for subagents
  "time": {
    "created": 1234567890,
    "updated": 1234567891
  }
  // ... other fields
}
```

### Update API

The relay script uses:
- **URL:** `http://127.0.0.1:4096/session/{sessionId}`
- **Method:** PATCH
- **Auth:** HTTP Basic (`opencode:opencode`)
- **Body:** `{"title": "new title"}`

## Browser Compatibility

- Chrome/Chromium 90+
- Firefox 88+
- Safari 14+
- Edge 90+

The dashboard uses:
- Fetch API
- ES6+ JavaScript
- CSS Grid
- CSS animations

All features are standard web technologies with no external dependencies.

## Troubleshooting

### Dashboard shows "Failed to fetch sessions"

**Causes:**
- OpenCode server not running at `http://127.0.0.1:4096`
- Network connectivity issue
- Browser CORS policy (if accessing from a different origin)

**Solution:**
- Verify OpenCode is running: `curl http://127.0.0.1:4096/session`
- Check network connectivity
- If CORS error, host the HTML file on the same origin as OpenCode

### relay.sh returns "Session not found"

**Cause:**
- The session ID is incorrect or the session has been terminated

**Solution:**
- Verify the session ID with: `curl -u opencode:opencode http://127.0.0.1:4096/session`
- Use the correct `id` value from the response

### Session titles don't update in dashboard

**Cause:**
- The 5-second refresh hasn't occurred yet
- The API call failed silently

**Solution:**
- Wait 5 seconds for auto-refresh
- Check relay.sh output for errors
- Verify the session ID is correct

## Notes

- The dashboard is stateless and stores no data
- All data comes directly from the OpenCode API
- Session information is read-only through the dashboard
- Updates can only be made via the relay.sh script or direct API calls
