# OpenCode Swarm Dashboard - Setup & Usage

## What Was Created

### 1. **dashboard.html** (7.3 KB)
A real-time HTML dashboard for monitoring OpenCode swarm agent sessions.

**Key Features:**
- Auto-refreshes every 5 seconds
- Shows session ID, title, agent type, role, and creation time
- Visual distinction between primary agents and subagents
- Clean dark theme UI
- Live status indicator

**To use:**
- Open `dashboard.html` in any web browser
- No server required - works directly with OpenCode API
- Authentication handled automatically via Basic Auth

### 2. **relay.sh** (2.2 KB, executable)
Shell script to update session titles with structured information.

**Key Features:**
- Sets clear, descriptive session titles
- Distinguishes primary agents from subagents
- Includes agent role and reference information in titles
- Colored output with status messages
- Error handling and validation

**To use:**
```bash
./relay.sh <session_id> "<task description>" [primary|subagent]
```

Examples:
```bash
./relay.sh ses_38c0887bdffe2JzKp2NvV4hrOZ "Build dashboard UI" primary
./relay.sh ses_38c08ad9cffeiQjoEArqhnLLgH "Fetch UI files" subagent
```

### 3. **DASHBOARD.md** (4.9 KB)
Complete documentation for both components.

## Quick Start

### View the Dashboard
```bash
# Open in your default browser
open ~/swarm/.opencode/plugin/dashboard.html

# Or open manually by dragging the file to a browser window
```

### Update a Session Title
```bash
# Make the script executable (already done)
chmod +x ~/swarm/.opencode/plugin/relay.sh

# Update a primary agent's session
~/swarm/.opencode/plugin/relay.sh ses_XXX "My task description" primary

# Update a subagent's session
~/swarm/.opencode/plugin/relay.sh ses_YYY "Subtask description" subagent
```

## Testing

The components have been tested with the live OpenCode server:

✓ Dashboard fetches sessions from API
✓ Sessions display correctly with roles
✓ Auto-refresh works
✓ relay.sh updates titles successfully
✓ Primary vs subagent distinction works
✓ Error handling (invalid session ID) works

## File Locations

```
~/swarm/.opencode/plugin/
├── dashboard.html      # The web dashboard
├── relay.sh           # Session title update script
├── DASHBOARD.md       # Full documentation
└── SETUP.md          # This file
```

## Technical Details

### API Endpoint
- **URL:** `http://127.0.0.1:4096/session`
- **Method:** GET
- **Auth:** Basic (opencode:opencode)
- **Response:** JSON array of sessions

### Session Update
- **URL:** `http://127.0.0.1:4096/session/{sessionId}`
- **Method:** PATCH
- **Auth:** Basic (opencode:opencode)
- **Body:** `{"title": "new title"}`

## Browser Support

- Chrome/Chromium 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Troubleshooting

**Dashboard won't load?**
- Check if OpenCode is running: `curl http://127.0.0.1:4096/session`

**relay.sh fails to update?**
- Verify session ID exists: `curl -u opencode:opencode http://127.0.0.1:4096/session | grep "ses_YOUR_ID"`

**Sessions don't show as subagents?**
- Make sure they have a `parentID` in the session data
- The relay.sh sets this correctly when you specify the "subagent" role

## Integration Example

When your agent spawns a subagent, update its title immediately:

```bash
#!/bin/bash
# In your agent creation script

SESSION_ID="ses_..."
TASK="Description of what this subagent does"

# Update the session title to indicate it's a subagent
~/swarm/.opencode/plugin/relay.sh "$SESSION_ID" "$TASK" subagent

# Continue with subagent work...
```

## Notes

- Dashboard is stateless (no persistent storage)
- All data comes live from OpenCode API
- Changes via relay.sh appear in dashboard after next refresh (5 seconds)
- Multiple browsers can view the dashboard simultaneously
- No configuration needed - works out of the box
