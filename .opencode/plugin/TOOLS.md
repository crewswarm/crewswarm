# OpenCode/OpenClaw Bridge Plugin - Tools Documentation

## Overview

This plugin provides a complete two-way bridge between OpenCode swarm agents and OpenClaw gateway, enabling:

- **Remote Execution**: Run commands and create sessions on OpenClaw
- **Shared Memory**: Persistent read/write, JSON, queues, and pub/sub
- **Browser Control**: Control OpenClaw's Chrome browser with logged-in sessions
- **Messaging**: Send messages via WhatsApp, Signal, Discord, Telegram
- **Session Management**: List, create, and kill sessions
- **OpenCrew RT**: Realtime WS/WSS protocol for orchestrator/PM/QA/fixer coordination

Recommended plugin entrypoint for OpenCode:

- `file:///Users/jeffhobbs/swarm/.opencode/plugin/opencrew-suite.ts`

---

## Authentication

All tools support optional API key authentication:

- **`OPENCLAW_API_KEY`**: Set to require API key for all tool calls
- **`OPENCLAW_REQUIRE_API_KEY`**: Set to `"1"` (default) to enforce authentication
- **`OPENCLAW_ALLOWED_AGENTS`**: Comma-separated list of allowed agent IDs (default: `main,admin,build,coder,researcher,architect,reviewer`)

### Usage

Pass the `apiKey` parameter to any tool:

```typescript
await tools.openclaw_send({
  message: "Hello from OpenCode",
  apiKey: "your-secret-key"
})
```

---

## OpenClaw Bridge Tools

## OpenCrew RT Tools

### `opencrew_rt_server`

Start, stop, or inspect the realtime OpenCrew WS/WSS server.

### `opencrew_rt_publish`

Publish a protocol envelope to a channel and persist it to shared memory.

### `opencrew_rt_assign`

High-level helper for PM/orchestrator assignment events (`task.assigned`).

### `opencrew_rt_issue`

High-level helper for QA escalation events (`qa.issue`).

### `opencrew_rt_command`

Publish strict control-plane commands on `command` (`command.run_task`, `command.collect_status`, etc.).

### `opencrew_rt_pull`

Read persisted protocol messages from shared-memory channel logs.

### `opencrew_rt_ack`

Store an acknowledgement status for a message (`received`, `in_progress`, `done`, `failed`, etc.).

See `CREWSWARM_RT_SPEC.md` for envelope schema and workflow.

---

## OpenClaw Bridge Tools

### `openclaw_send`

Send a message to OpenClaw main session and get a reply.

**Args:**
- `message` (string, required): Message to send
- `resetSession` (boolean, optional): Reset the OpenClaw main session before sending
- `stream` (boolean, optional): Enable streaming response (returns chunks as they arrive)
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Reply from OpenClaw

**Example:**
```typescript
const response = await tools.openclaw_send({
  message: "What's the weather in Toronto?",
  stream: true
})
```

---

### `openclaw_status`

Get the current status of the OpenClaw gateway.

**Args:**
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Status information (gateway uptime, sessions, etc.)

**Example:**
```typescript
const status = await tools.openclaw_status()
// Output: "[openclaw-bridge] Gateway running: 5 active sessions..."
```

---

### `openclaw_session_list`

List all active OpenClaw sessions.

**Args:**
- `apiKey` (string, optional): API key when authentication is required

**Returns:** List of active session IDs and metadata

**Example:**
```typescript
const sessions = await tools.openclaw_session_list()
// Output: "[openclaw-bridge] Sessions: main, sub-agent-1, sub-agent-2"
```

---

### `openclaw_session_kill`

Terminate an OpenClaw session by ID.

**Args:**
- `sessionId` (string, required): Session ID to kill
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Confirmation message

**Example:**
```typescript
const result = await tools.openclaw_session_kill({
  sessionId: "sub-agent-1"
})
```

---

### `openclaw_session_create`

Create a new OpenClaw session.

**Args:**
- `title` (string, optional): Human-readable session title
- `systemPrompt` (string, optional): Custom system prompt for the session
- `apiKey` (string, optional): API key when authentication is required

**Returns:** New session ID and creation details

**Example:**
```typescript
const newSession = await tools.openclaw_session_create({
  title: "Web Research Task",
  systemPrompt: "You are a web researcher. Find and summarize information about..."
})
// Output: "[openclaw-bridge] Created session: ses_abc123"
```

---

### `openclaw_exec`

Execute a shell command on the OpenClaw host. **USE WITH CAUTION** - dangerous commands are blocked.

**Args:**
- `command` (string, required): Shell command to execute
- `timeout` (number, optional): Timeout in seconds (default: 60, max: 300)
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Command output

**Blocked Patterns:**
- `rm -rf /` and similar destructive commands
- `curl | bash` (network-based code execution)
- `fork()` (fork bombs)
- Other dangerous patterns

**Example:**
```typescript
const output = await tools.openclaw_exec({
  command: "ls -la /tmp/openclaw/uploads/",
  timeout: 30
})
```

---

### `openclaw_browse`

Control OpenClaw's Chrome browser (with your logged-in sessions).

**Args:**
- `action` (string, required): Browser action - `status`, `tabs`, `snapshot`, `screenshot`, `navigate`
- `profile` (string, optional): Browser profile to use (default: `chrome`)
- `targetUrl` (string, optional): URL for the `navigate` action
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Browser state or screenshot

**Actions:**

| Action | Description |
|--------|-------------|
| `status` | Get browser status and list of open tabs |
| `tabs` | List all open tabs with URLs |
| `snapshot` | Take a snapshot of the current page (returns DOM) |
| `screenshot` | Take a screenshot image |
| `navigate` | Navigate to a URL (requires `targetUrl`) |

**Example:**
```typescript
// Get browser status
const status = await tools.openclaw_browse({
  action: "status",
  profile: "chrome"
})

// Navigate to a URL
const result = await tools.openclaw_browse({
  action: "navigate",
  profile: "chrome",
  targetUrl: "https://google.com"
})

// Take a screenshot
const screenshot = await tools.openclaw_browse({
  action: "screenshot",
  profile: "chrome"
})
```

---

### `openclaw_message`

Send a message via OpenClaw (WhatsApp, Signal, Discord, Telegram, etc.).

**Args:**
- `target` (string, required): Recipient (phone number, username, or channel name)
- `message` (string, required): Message text
- `media` (string, optional): Path to media file to attach
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Confirmation message

**Examples:**

```typescript
// Send WhatsApp message
const result = await tools.openclaw_message({
  target: "+1-555-123-4567",
  message: "Hello! This is a test message from OpenCode."
})

// Send message with image
const result = await tools.openclaw_message({
  target: "my-discord-channel",
  message: "Check out this image!",
  media: "/Users/jeff/.openclaw/workspace/media/screenshot.png"
})

// Send Signal message
const result = await tools.openclaw_message({
  target: "alice@signal",
  message: "Secure message from OpenCode"
})
```

---

## Shared Memory Tools

### Basic Text Operations

#### `memory_write`

Write a text value to shared memory.

**Args:**
- `key` (string, required): Memory key name (1-80 chars: letters, numbers, dot, underscore, dash)
- `value` (string, required): Value to store
- `append` (boolean, optional): Append to existing value instead of overwriting
- `apiKey` (string, optional): API key when authentication is required

**Example:**
```typescript
await tools.memory_write({
  key: "plugin-progress",
  value: "Phase 1: Bridge implementation complete"
})
```

---

#### `memory_read`

Read a text value from shared memory.

**Args:**
- `key` (string, required): Memory key to read
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Text content or "not found" message

**Example:**
```typescript
const progress = await tools.memory_read({
  key: "plugin-progress"
})
```

---

#### `memory_list`

List all text memory keys in the namespace.

**Args:**
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Comma-separated list of keys

**Example:**
```typescript
const keys = await tools.memory_list()
// Output: "[memory:claw-swarm] plugin-progress, task-state, agent-results"
```

---

#### `memory_delete`

Delete a memory key.

**Args:**
- `key` (string, required): Memory key to delete
- `apiKey` (string, optional): API key when authentication is required

**Example:**
```typescript
await tools.memory_delete({
  key: "temp-data"
})
```

---

### JSON Operations

#### `memory_write_json`

Write JSON data to shared memory with optional merging.

**Args:**
- `key` (string, required): Memory key for JSON
- `value` (string, required): JSON string (object, array, or primitive)
- `merge` (boolean, optional): Merge with existing JSON using deep merge
- `apiKey` (string, optional): API key when authentication is required

**Example:**
```typescript
await tools.memory_write_json({
  key: "agent-state",
  value: JSON.stringify({
    agentId: "builder-1",
    tasksCompleted: 5,
    status: "active"
  })
})

// Merge with existing
await tools.memory_write_json({
  key: "agent-state",
  value: JSON.stringify({
    tasksCompleted: 6,
    lastUpdate: new Date().toISOString()
  }),
  merge: true
})
```

---

#### `memory_read_json`

Read JSON data from shared memory.

**Args:**
- `key` (string, required): Memory key to read
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Formatted JSON or error message

**Example:**
```typescript
const state = await tools.memory_read_json({
  key: "agent-state"
})
// Returns: { agentId: "builder-1", tasksCompleted: 6, ... }
```

---

### Queue Operations (FIFO)

#### `memory_queue_push`

Push data onto a named FIFO queue.

**Args:**
- `queue` (string, required): Queue name
- `data` (string, required): Data to enqueue
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Message ID and queue size

**Example:**
```typescript
await tools.memory_queue_push({
  queue: "tasks",
  data: JSON.stringify({
    id: "task-123",
    action: "build",
    priority: "high"
  })
})
```

---

#### `memory_queue_pop`

Pop (dequeue) the oldest item from a queue.

**Args:**
- `queue` (string, required): Queue name
- `timeout` (number, optional): Wait timeout in seconds (default: 0 = no wait)
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Oldest item in queue or "empty" message

**Example:**
```typescript
// Non-blocking (return immediately if empty)
const item = await tools.memory_queue_pop({
  queue: "tasks"
})

// Blocking (wait up to 10 seconds for an item)
const item = await tools.memory_queue_pop({
  queue: "tasks",
  timeout: 10
})
```

---

#### `memory_queue_size`

Get the number of items in a queue.

**Args:**
- `queue` (string, required): Queue name
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Queue size

**Example:**
```typescript
const size = await tools.memory_queue_size({
  queue: "tasks"
})
// Output: "[memory] Queue "tasks" size: 5"
```

---

#### `memory_queue_list`

List all queues.

**Args:**
- `apiKey` (string, optional): API key when authentication is required

**Returns:** List of queue names

**Example:**
```typescript
const queues = await tools.memory_queue_list()
// Output: "[memory] Queues: tasks, events, notifications"
```

---

### Pub/Sub Operations

#### `memory_publish`

Publish a message to a pub/sub channel. All subscribers receive it immediately.

**Args:**
- `channel` (string, required): Channel name
- `message` (string, required): Message to publish
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Confirmation with subscriber count

**Example:**
```typescript
await tools.memory_publish({
  channel: "build-status",
  message: JSON.stringify({
    status: "complete",
    duration: 45000,
    success: true
  })
})
```

---

#### `memory_subscribe`

Subscribe to a pub/sub channel. Returns recent message history.

**Args:**
- `channel` (string, required): Channel name to subscribe to
- `apiKey` (string, optional): API key when authentication is required

**Returns:** Subscription ID and recent message history

**Example:**
```typescript
const sub = await tools.memory_subscribe({
  channel: "build-status"
})
// Output: "[memory] Subscribed to "build-status" (sub_id: ...)
//          [memory] Recent messages:
//          [2026-02-18T22:50:00Z] {"status":"complete",...}"
```

---

#### `memory_channel_list`

List all pub/sub channels with message and subscriber counts.

**Args:**
- `apiKey` (string, optional): API key when authentication is required

**Returns:** List of channels with stats

**Example:**
```typescript
const channels = await tools.memory_channel_list()
// Output: "[memory] Channels:
//          build-status: 10 messages, 3 subscribers
//          errors: 2 messages, 1 subscriber"
```

---

## Best Practices

### Error Handling

All tools return error messages with `[prefix]` tags. Wrap calls in try/catch:

```typescript
try {
  const result = await tools.openclaw_send({
    message: "test"
  })
} catch (err) {
  if (err.message.includes("Unauthorized")) {
    // Handle auth error
  }
}
```

### Memory Namespaces

By default, memory is stored in the `claw-swarm` namespace. Override with:

```bash
export SHARED_MEMORY_DIR="$HOME/.openclaw/workspace/shared-memory"
export SHARED_MEMORY_NAMESPACE="my-agents"
```

### Safe Command Execution

The `openclaw_exec` tool blocks dangerous patterns. Use it for:

✅ Safe: `ls`, `cat`, `grep`, `curl` (URL fetch), `ffmpeg`, `git status`
❌ Unsafe: `rm -rf /`, `curl | bash`, `fork()`, destructive commands

### Timeout Handling

Set appropriate timeouts for long-running operations:

```typescript
await tools.openclaw_exec({
  command: "npm install --prefer-offline",
  timeout: 120  // 2 minutes
})

// Wait for queue item with 30-second timeout
const item = await tools.memory_queue_pop({
  queue: "slow-tasks",
  timeout: 30
})
```

---

## Configuration Reference

| Env Var | Purpose | Default |
|---------|---------|---------|
| `OPENCLAW_API_KEY` | Shared secret for authentication | (none) |
| `OPENCLAW_REQUIRE_API_KEY` | Enforce API key check | `"1"` |
| `OPENCLAW_ALLOWED_AGENTS` | Comma-separated agent IDs | `main,admin,build,coder,researcher,architect,reviewer` |
| `OPENCLAW_BRIDGE_PATH` | Path to gateway bridge | `~/Desktop/OpenClaw/gateway-bridge.mjs` |
| `OPENCLAW_ALLOW_ANY_BRIDGE_PATH` | Skip path validation | `"0"` (off) |
| `OPENCLAW_ALLOW_MISSING_CONTEXT` | Skip context validation | `"0"` (off) |
| `OPENCLAW_ALLOWED_MESSAGE_TARGETS` | Comma-separated allowlist for `openclaw_message` targets | (empty = all messaging blocked) |
| `OPENCLAW_ALLOW_UNRESTRICTED_MESSAGING` | Bypass target allowlist for messaging | `"0"` (off) |
| `CREWSWARM_RT_HOST` | OpenCrew RT bind host | `127.0.0.1` |
| `CREWSWARM_RT_PORT` | OpenCrew RT bind port | `18889` |
| `CREWSWARM_RT_REQUIRE_TOKEN` | Require hello token auth for socket clients | `"1"` |
| `CREWSWARM_RT_AUTH_TOKEN` | Socket auth token when token auth is enabled | (none) |
| `CREWSWARM_RT_REQUIRE_AGENT_TOKEN` | Require per-agent socket tokens | `"0"` |
| `CREWSWARM_RT_AGENT_TOKENS` | Per-agent token map (`agent:token;agent:token`) | (none) |
| `CREWSWARM_RT_ALLOWED_ORIGINS` | Origin allowlist for WS upgrade | (none) |
| `CREWSWARM_RT_MAX_MESSAGE_BYTES` | Max inbound frame size in bytes | `65536` |
| `CREWSWARM_RT_RATE_LIMIT_PER_MIN` | Max socket messages per minute per client | `300` |
| `CREWSWARM_RT_CHANNELS` | Subscribed channels for OpenClaw realtime daemon | `command,assign,handoff,reassign,events` |
| `CREWSWARM_RT_TLS_KEY_PATH` | TLS key path for WSS | (none) |
| `CREWSWARM_RT_TLS_CERT_PATH` | TLS cert path for WSS | (none) |
| `CREWSWARM_RT_AUTO_START` | Autostart realtime server when plugin loads | `"1"` |
| `CREWSWARM_RT_BOOTSTRAP_CHANNELS` | Precreate standard protocol channel logs | `"1"` |
| `SHARED_MEMORY_DIR` | Base directory for shared memory | `~/.openclaw/workspace/shared-memory` |
| `SHARED_MEMORY_NAMESPACE` | Namespace for memory keys | `claw-swarm` |

---

## Examples

### Complete Workflow: Build Task with Progress Tracking

```typescript
// 1. Create a new session for building
const session = await tools.openclaw_session_create({
  title: "Build Next.js App",
  systemPrompt: "You are a Node.js build expert..."
})

// 2. Subscribe to build status channel
await tools.memory_subscribe({
  channel: "build-status"
})

// 3. Queue build tasks
await tools.memory_queue_push({
  queue: "build-tasks",
  data: JSON.stringify({
    step: 1,
    action: "npm install"
  })
})

// 4. Send build command to new session
const result = await tools.openclaw_send({
  message: `Use session ${session} to build. Pop tasks from memory_queue_pop(queue="build-tasks") and execute them.`
})

// 5. Monitor progress via memory
while (true) {
  const state = await tools.memory_read_json({
    key: "build-state"
  })
  
  if (state.complete) break
  
  await new Promise(r => setTimeout(r, 5000))
}

// 6. Get final results
const results = await tools.memory_read_json({
  key: "build-results"
})
```

### Using Shared Memory as IPC Between Sessions

```typescript
// Agent 1: Producer
await tools.memory_queue_push({
  queue: "work-items",
  data: JSON.stringify({ id: 1, work: "parse data" })
})
await tools.memory_publish({
  channel: "notifications",
  message: "New work item queued"
})

// Agent 2: Consumer (in another session)
const item = await tools.memory_queue_pop({
  queue: "work-items",
  timeout: 30
})

// Process and report back
await tools.memory_write_json({
  key: `results-${item.id}`,
  value: JSON.stringify({ processed: true, time: Date.now() })
})
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Unauthorized: invalid API key` | Wrong or missing API key | Check `OPENCLAW_API_KEY` env var |
| `Bridge path not found` | Gateway bridge missing | Create `~/Desktop/OpenClaw/gateway-bridge.mjs` |
| `Command contains dangerous pattern` | Blocked command pattern | Use safer alternative |
| `Queue is empty` | No items to pop | Check `memory_queue_size` first |
| `Invalid JSON` | Malformed JSON in memory_write_json | Validate with `JSON.stringify` |

---

## License

MIT
