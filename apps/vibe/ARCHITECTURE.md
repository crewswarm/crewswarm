# crewswarm Vibe — Architecture Overview

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERFACES                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Dashboard   │  │    Vibe      │  │  CrewChat    │          │
│  │  :4319       │  │   :3333      │  │  (Native)    │          │
│  │              │  │              │  │              │          │
│  │  • Config    │  │  • Monaco    │  │  • Quick     │          │
│  │  • Agents    │  │  • File Tree │  │    Mode      │          │
│  │  • Chat      │  │  • Chat      │  │  • Advanced  │          │
│  │  • Services  │  │  • Terminal  │  │    Mode      │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│         │                  │                  │                  │
└─────────┼──────────────────┼──────────────────┼─────────────────┘
          │                  │                  │
          │    REST API      │    REST API      │    REST API
          │    WebSocket     │    WebSocket     │    WebSocket
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  crew-lead (:5010)                                       │   │
│  │  • Chat handler                                          │   │
│  │  • Task dispatch                                         │   │
│  │  • REST API                                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  RT Message Bus (:18889)                                 │   │
│  │  • WebSocket pub/sub                                     │   │
│  │  • Agent coordination                                    │   │
│  │  • Real-time updates                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Agent Bridges (gateway-bridge.mjs × 20)                 │   │
│  │                                                           │   │
│  │  crew-coder    crew-qa     crew-pm     crew-fixer       │   │
│  │  crew-frontend crew-security crew-main crew-github      │   │
│  │  crew-architect crew-seo   crew-ml     crew-copywriter  │   │
│  │  ...                                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Execution Engines                                       │   │
│  │                                                           │   │
│  │  OpenCode CLI    Cursor CLI    Claude Code    Codex     │   │
│  │  Gemini CLI      Direct API                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: User Message → Agent Response

### Vibe Example

```
1. USER types in Vibe chat: "Add login validation"

2. Vibe → local Studio API
   POST http://127.0.0.1:3333/api/studio/chat/unified
   { mode: "cli", engine: "codex", message: "Add login validation", projectId: "my-app" }

3. local server runs the selected CLI
   → Executes Codex in the selected project directory
   → Streams chunks back to the client
   → Saves the exchange to local project messages

4. Vibe updates the editor + chat state
   → Chat shows the CLI transcript
   → File tree can be refreshed from local fs APIs

5. File tree updates (future: watch fs events)
   → validation.js appears in tree
   → Click to open in Monaco editor
```

---

## Vibe-Specific Components

### File Tree
- **Current:** Real filesystem-backed file list from the local Studio server
- **Next:** Add fs watchers for live refresh
- **Future:** Git status indicators (M, A, D)

### Monaco Editor
- **Current:** Edit + auto-save (1s debounce)
- **Next:** Multi-cursor, find/replace, inline diffs
- **Future:** Agent inline suggestions (Copilot-style)

### Chat Panel
- **Current:** Send local CLI requests and dashboard-backed chat requests, then render streamed responses
- **Next:** Expand direct specialist routing from the Studio surface
- **Future:** Thread support, context injection

### Terminal
- **Current:** Local shell session over WebSocket
- **Next:** Filter logs and improve shell controls
- **Future:** Interactive commands (stop task, retry)

---

## API Endpoints Used by Vibe

### Local Studio API (:3333)

```
POST /api/studio/chat/unified
Body: { mode: "cli", engine: string, message: string, projectId?: string, projectDir?: string }
Response: Server-sent events with streamed chunks + done event

GET /api/studio/projects
Response: { ok: true, projects: [{ id, name, outputDir, description }] }

GET /api/studio/files?dir=/absolute/project/path
Response: { files: [{ path, name, ext, size, modifiedAt }] }

GET /api/studio/file-content?path=/absolute/file/path
Response: { content: string, lines: number }

POST /api/studio/file-content
Body: { path: string, content: string }
Response: { ok: true, path: string, size: number }

GET /api/studio/project-messages?projectId=:projectId
Response: { messages: [...] }
```

### RT Message Bus (:18889)

```
WebSocket connection
→ Receive all agent activity events
→ No auth required (localhost only)

Event types:
- task_claimed
- task_completed
- tool_call
- agent_status_change
```

---

## Deployment Scenarios

### Scenario 1: Local Development
```
localhost:4319  → Dashboard (config + management)
localhost:3333  → Vibe (coding interface)
localhost:5010  → crew-lead (backend)
localhost:18889 → RT bus (coordination)
```

All services on one machine. Fast, no network latency.

### Scenario 2: Shared Team Server
```
server:4319     → Dashboard (team access)
server:3333     → Vibe (optional, for web-based coding)
server:5010     → crew-lead
server:18889    → RT bus

Users connect from:
- Cursor (via MCP) → calls :5010
- Vibe (browser) → :3333
- Dashboard (browser) → :4319
```

Central server, multiple users. Add auth/multi-tenancy.

### Scenario 3: Docker Container
```
Container ports:
- 4319 (dashboard)
- 3333 (Vibe)
- 5010 (crew-lead)
- 18889 (RT bus)

Docker Compose:
services:
  crewswarm:
    image: crewswarm/crewswarm
    ports:
      - "4319:4319"
      - "3333:3333"
      - "5010:5010"
      - "18889:18889"
    volumes:
      - ~/.crewswarm:/root/.crewswarm
```

Isolated, portable, easy deployment.

---

## Security Considerations

### Current (localhost only)
- No auth on RT bus (WebSocket)
- Dashboard API partially protected (RT token)
- Vibe assumes trusted localhost environment

### Production Recommendations
1. **Add authentication:**
   - JWT tokens for all APIs
   - WebSocket auth handshake
   - Rate limiting per user

2. **Restrict file access:**
   - Sandbox agents to project directories
   - Validate all file paths (no ../)
   - Audit log for file operations

3. **Network isolation:**
   - RT bus on internal network only
   - Dashboard/Vibe behind reverse proxy
   - TLS for all external connections

4. **Multi-tenancy:**
   - User-scoped projects
   - Agent resource quotas
   - Billing/usage tracking

---

## Performance Characteristics

### Vibe Load Times
- **Initial:** ~500ms (Monaco bundle)
- **File open:** ~50ms (mock data) / ~200ms (real fs)
- **Chat message:** ~100ms (REST) + LLM time
- **RT update:** ~10ms (WebSocket latency)

### Scalability
- **Agents:** 20 concurrent bridges (1 per agent)
- **Chat messages:** ~1000/min (crew-lead)
- **RT events:** ~10k/min (bus capacity)
- **File operations:** Limited by fs (future: cache)

### Resource Usage
- **Vibe (dev):** ~100MB RAM, 1 CPU core (Vite)
- **Vibe (prod):** ~20MB RAM, 0.1 CPU core (static)
- **Monaco:** ~30MB RAM per editor instance

---

## Future Enhancements

### Phase 2 (File Operations)
- Real fs integration (dashboard API)
- Multi-file editing (split editor)
- Diff view (compare before/after)

### Phase 3 (Advanced Features)
- Desktop app (Electron/Tauri)
- Git operations (commit, push, PR)
- Collaborative mode (multiple users)
- Plugin system (extensions)

### Phase 4 (Enterprise)
- SSO authentication
- Role-based access control
- Audit logging
- Usage analytics

---

## Testing Strategy

### Unit Tests
```bash
cd apps/vibe
npm test
```
Test editor ops, chat handlers, file tree rendering.

### Integration Tests
```bash
cd apps/vibe
npm run test:e2e
```
Test the shipped server routes, local file APIs, and built runtime assets.

### Manual Testing
1. Open Vibe: `bash start-studio.sh`
2. Send chat message
3. Verify terminal shows agent activity
4. Open file from tree
5. Edit + save
6. Verify the local file save shows up on refresh

---

## Troubleshooting

See `STUDIO-SETUP-COMPLETE.md` → Troubleshooting section.

Common issues:
- Port conflicts (3333 in use)
- Auth token missing (dashboard not running)
- RT bus disconnected (daemon not started)
- File operations fail (API not implemented yet)

---

**Last Updated:** March 2026  
**Version:** 1.0.0  
**Status:** Phase 1 Complete (editor + chat + terminal)
